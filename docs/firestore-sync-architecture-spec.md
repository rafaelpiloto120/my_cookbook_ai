# Firestore Sync Architecture Spec

## Goal

Define a scalable sync model for MyCookbook AI where:

- Firestore is the canonical persisted source of truth
- local device storage is a cache and offline mutation queue
- anonymous users are supported cleanly
- account transitions are predictable
- new domains and fields can be added without redesigning sync again

---

## Core Decision

### Source of truth

Firestore is the canonical persisted source of truth for user-owned data.

AsyncStorage should not be treated as the business source of truth. It should only be used for:

- local cache for fast reads
- offline access
- pending local mutations waiting to sync
- temporary UI/session state

---

## Backend vs Direct Firestore

### Recommendation

Use a **hybrid architecture**:

- **Direct app <-> Firestore** for standard user-owned CRUD domains
- **App <-> Backend <-> Firestore** for privileged, priced, or server-controlled domains

### Direct Firestore is recommended for

- recipes
- cookbooks
- preferences
- My Day profile
- My Day meals
- My Day weight logs

### Backend-mediated writes are recommended for

- economy / cookies / premium-action deductions
- rewards / grants
- purchases verification
- AI outputs that must be validated or charged
- admin / migration / repair jobs
- any server-enriched writes that should not be trusted from client input alone

### Why

Direct Firestore for normal user data is more scalable because:

- it removes the backend from routine sync traffic
- Firestore SDK already handles retries, offline, and listeners well
- it reduces backend CPU/network pressure
- it avoids inventing a custom sync transport for every domain

Backend mediation is still the right choice for economy and AI because:

- these flows must be authoritative
- we should not trust the client to charge itself correctly
- some writes depend on verification, transactions, or third-party systems

### Final position

The current “frontend -> backend -> Firestore” model for everything is not the best long-term shape.

The recommended target architecture is:

- user content domains sync directly with Firestore
- economy and server-authoritative domains stay backend-first

---

## User Data Domains

All user-owned data lives under:

- `users/{uid}/recipes/{recipeId}`
- `users/{uid}/cookbooks/{cookbookId}`
- `users/{uid}/preferences/default`
- `users/{uid}/myDay/profile/default`
- `users/{uid}/myDay/meals/{mealId}`
- `users/{uid}/myDay/weights/{weightId}`
- `users/{uid}/economy/default`
- `users/{uid}/economy/default/ledger/{entryId}`

Optional future domains:

- `users/{uid}/products/...`
- `users/{uid}/featureState/...`
- `users/{uid}/migrationState/...`

---

## Domain Ownership

### Client-owned sync domains

These can be edited by the client and synced directly to Firestore:

- recipes
- cookbooks
- preferences
- My Day profile
- My Day meals
- My Day weight logs

### Server-owned domains

These must remain backend-authoritative:

- economy balance
- free premium actions
- ledger entries
- reward grants
- purchase verification state

The client may read them, but it should not write them directly.

---

## Auth Model

### Anonymous users

Anonymous users are first-class users and get a real Firebase `uid`.

That means:

- anonymous users can write to Firestore under their own `uid`
- their recipes, meals, preferences, and cookbooks belong to that anonymous `uid`
- no special local-only sync mode is needed

This is the cleanest model.

### Signed-in users

Signed-in users also write under their Firebase `uid`.

### Important principle

All sync and Firestore access should be keyed only by the authenticated Firebase user id.

Do not rely on:

- body `uid`
- custom user-id headers
- device id as a persistence identity

Those can still exist for analytics/debug compatibility, but not as the true sync identity.

---

## Auth Transition Rules

### Case A: Anonymous user links account

Example:

- user starts anonymous
- creates recipes/meals
- signs up from that same session using link flow

Result:

- same Firebase `uid`
- same Firestore documents
- no merge needed
- data remains intact

This is the ideal path and should be preferred.

### Case B: Anonymous user signs in to an existing different account

Example:

- anonymous user creates 2 recipes
- then logs into an already existing account with a different `uid`

Recommended behavior:

- active source of truth immediately becomes the signed-in account’s Firestore data
- the 2 anonymous recipes do **not** silently merge into the existing account
- those anonymous recipes remain attached to the old anonymous `uid`
- local cache is switched to the signed-in account’s dataset

That means:

- the existing account sees only its own recipes
- the anonymous recipes are effectively left behind with the anonymous account

### Why we should not auto-merge

Auto-merging is risky because:

- it can duplicate content
- it can overwrite newer data
- it is hard to do correctly across recipes, meals, profile, preferences, and economy
- it creates surprising behavior

### Future enhancement

Later, if desired, we can add an explicit one-time import flow:

- “You created data as a guest. Do you want to import it into this account?”

But that should be deliberate, not automatic.

### Case C: Logged-in user logs out

Recommended behavior:

- clear local caches and pending local mutation queues
- stop listeners/subscriptions
- sign into a fresh anonymous user
- initialize new local cache for the new anonymous `uid`

No signed-in data should remain visible after logout.

---

## Local Device Model

Each syncable domain should have:

- local cache
- pending mutation queue
- serializer / validator
- conflict strategy
- schema version

### Example local shape

For each domain:

- cached document/collection snapshot
- metadata:
  - `lastSyncedAt`
  - `lastKnownServerState`
  - `pendingMutations[]`
  - `schemaVersion`

### Important rule

UI should read from the domain cache abstraction, not directly from ad hoc AsyncStorage keys like:

- `recipes`
- `cookbooks`
- `myDayMeals`
- `myDayProfile`

Those legacy keys should be phased out.

---

## Sync Strategy

### Recipes / Cookbooks / Preferences / My Day

Use Firestore SDK directly from the app:

- fetch initial snapshot
- subscribe where useful
- write locally first
- enqueue mutation
- sync mutation to Firestore
- reconcile success/failure

### Economy

Use backend endpoints only:

- fetch balance
- fetch history
- preview premium action
- commit premium action
- claim rewards
- verify purchases

Firestore remains canonical for economy, but the client does not write it directly.

---

## Conflict Strategy

### General rule

For user content domains, use:

- record-level `updatedAt`
- domain `schemaVersion`
- domain-specific merge rules

### Domain-specific guidance

#### Preferences

- last-write-wins is acceptable

#### Recipes

- last-write-wins at document level is acceptable for now
- normalize nested fields before persistence
- `nutritionInfo` and `mealLoggingRepresentation` must be part of the synced canonical recipe doc

#### Cookbooks

- last-write-wins is acceptable

#### My Day meals

- record-level replacement is acceptable
- meals are append-heavy and usually isolated by id

#### My Day profile

- last-write-wins is acceptable

#### Economy

- server-authoritative only

### Important note

Do not keep relying only on “legacy snapshot merged by updatedAt” as the architectural model.
That is a migration bridge, not the target design.

---

## My Day Requirements

My Day must join the sync architecture.

Current issue:

- My Day profile, meals, and weight logs are local-only
- they are outside the main sync engine
- this breaks the “Firestore is source of truth” goal

### Required synced domains

- `users/{uid}/myDay/profile/default`
- `users/{uid}/myDay/meals/{mealId}`
- `users/{uid}/myDay/weights/{weightId}`

### Product behavior

- anonymous users can use My Day and sync under anonymous `uid`
- linked users keep the same data
- logout clears local My Day cache and moves to fresh anonymous state

---

## Recipe Requirements

The synced recipe document must include the newer product state, not only the older recipe fields.

Required canonical fields include:

- core recipe fields
- `nutritionInfo`
- `mealLoggingRepresentation`
- import metadata if relevant
- image metadata
- tags / cookbook relationships

This avoids the current split where newer recipe state can exist locally but not be treated as part of the canonical synced model.

---

## Economy Requirements

Economy should remain Firestore-backed but backend-authoritative.

### Client can read

- balance
- free premium actions remaining
- ledger entries
- catalog
- reward availability

### Client cannot authoritatively write

- cookie balance
- free premium action consumption
- reward grants
- purchases verification

### Reason

These are business-critical and must remain transactionally safe.

---

## Security Model

### For direct Firestore domains

Use Firestore Security Rules so users can only access:

- `users/{request.auth.uid}/...`

### For backend-only domains

Use backend token verification and server-side transactions.

### Principle

User-owned content can be client-written with rules.
Economy and monetization cannot.

---

## Schema Evolution

To make future changes scalable:

Every domain should define:

- `schemaVersion`
- normalizer
- migration steps for local cache
- backward-compatible defaults for missing fields

### Example

When adding a new recipe field:

- add it to canonical Firestore doc shape
- default it in the normalizer
- add local cache migration if needed
- avoid creating separate side-channel storage unless truly necessary

This lets us add:

- new nutrition fields
- new My Day subfeatures
- new products
- new analytics-linked metadata

without redesigning sync each time.

---

## Rollout Plan

### Phase 1: Lock architecture

- adopt Firestore as canonical persisted source of truth
- adopt hybrid direct-Firestore + backend-authoritative model
- freeze domain list and document paths

### Phase 2: Secure the older sync paths

- stop relying on body `uid` for recipes/cookbooks
- require verified Firebase token identity
- keep legacy endpoints temporarily if needed for transition

### Phase 3: Bring My Day into sync

Add:

- `MyDayProfileSync`
- `MyDayMealsSync`
- `MyDayWeightSync`

### Phase 4: Remove legacy snapshot-first behavior

Gradually eliminate direct UI dependence on:

- `recipes`
- `cookbooks`
- `myDayMeals`
- `myDayProfile`

Replace with domain repositories/cache accessors.

### Phase 5: Refine account transition UX

Add optional future feature:

- explicit guest-data import into existing account

This should be a later product decision, not part of the initial refactor.

---

## Final Decisions

### Confirmed

- Firestore is the source of truth
- anonymous users are real synced users
- linked anonymous -> account keeps same data
- signing into a different existing account does not auto-merge guest data
- My Day must be added to sync
- economy remains backend-authoritative
- future sync should be hybrid, not backend-for-everything

### Open question for later

- whether we want an explicit guest-data import flow for anonymous -> existing-account login

