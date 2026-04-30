# Firestore Sync Implementation Plan

## Objective

Move the app from its current mixed sync model to the target architecture defined in:

- [firestore-sync-architecture-spec.md](/Users/rpiloto/recipe-ai-app/docs/firestore-sync-architecture-spec.md)

This plan is intentionally phased so we can improve correctness first, then scalability, then cleanup.

---

## Current Reality

Today the app has 3 different persistence models:

1. Sync engine domains
- recipes
- cookbooks
- preferences

2. Local-only domains
- My Day profile
- My Day meals
- My Day weight logs

3. Backend-authoritative Firestore domains
- economy / cookies / rewards / premium actions

This plan brings them into a cleaner model:

- Firestore canonical for user-owned data
- local cache for offline / UI
- backend-authoritative only where needed

---

## Phase 1: Identity And Security Hardening

### Goal

Make sure sync identity is always the authenticated Firebase user, not request-body uid.

### Why first

Before expanding sync to My Day, we should make sure the older recipe/cookbook sync model is using the right identity boundary.

### Work

#### 1.1 Harden recipe sync endpoints

Current issue:

- `/sync/recipes/pull`
- `/sync/recipes/push`

still accept `uid` from the request body.

Target:

- verify Firebase ID token
- derive `uid` only from the verified token
- ignore body `uid` for authorization

Compatibility strategy:

- allow legacy body `uid` only temporarily in dev / migration mode if needed
- log all fallback usage so we can remove it

#### 1.2 Harden cookbook sync endpoints

Same rule as recipes:

- `/sync/cookbooks/pull`
- `/sync/cookbooks/push`

must stop trusting body `uid` as the effective identity

#### 1.3 Confirm preferences path stays token-authenticated

Preferences is already closer to the target shape.

Work:

- verify consistency with recipes/cookbooks
- ensure auth failures are handled cleanly

#### 1.4 Audit Security Rules readiness

If we move more data to direct Firestore access later, we need a clear rules model:

- `users/{request.auth.uid}/...`

Deliverable:

- draft Firestore rules map by collection path

### Files likely involved

- [backend/index.js](/Users/rpiloto/recipe-ai-app/backend/index.js)
- [frontend/RecipeAI/lib/sync/RecipeSync.ts](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/lib/sync/RecipeSync.ts)
- [frontend/RecipeAI/lib/sync/CookbookSync.ts](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/lib/sync/CookbookSync.ts)
- [frontend/RecipeAI/lib/sync/PreferencesSync.ts](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/lib/sync/PreferencesSync.ts)

### Done when

- recipe sync uses verified auth identity
- cookbook sync uses verified auth identity
- no production authorization depends on body `uid`

---

## Phase 2: Canonical My Day Data Model

### Goal

Define the Firestore shape for My Day before wiring sync logic.

### Work

#### 2.1 Define Firestore document paths

Use:

- `users/{uid}/myDay/profile/default`
- `users/{uid}/myDay/meals/{mealId}`
- `users/{uid}/myDay/weights/{weightId}`

#### 2.2 Define canonical document shapes

##### My Day profile

Should include:

- age
- height / canonical normalized height
- current weight / canonical normalized weight
- target weight / canonical normalized target weight
- gender
- goal type
- pace
- plan
- customized-plan flag
- updatedAt
- schemaVersion

##### My Day meal

Should include:

- id
- title
- source
- createdAt
- dayKey
- calories
- protein
- carbs
- fat
- rawInput
- recipeId
- servingMultiplier
- ingredients
- updatedAt
- schemaVersion

##### My Day weight log

Should include:

- id
- date / createdAt
- weight
- normalizedWeightKg
- note if relevant
- updatedAt
- schemaVersion

#### 2.3 Decide deletion behavior

Recommendation:

- use soft delete only if product needs recovery/history
- otherwise hard delete is acceptable for My Day meals and weight logs

My recommendation for now:

- meals: hard delete acceptable
- weights: hard delete acceptable
- profile: overwrite singleton doc

### Files likely involved

- [frontend/RecipeAI/lib/myDay.ts](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/lib/myDay.ts)
- [frontend/RecipeAI/lib/myDayMeals.ts](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/lib/myDayMeals.ts)
- [frontend/RecipeAI/lib/myDayWeight.ts](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/lib/myDayWeight.ts)
- new sync types file additions under [frontend/RecipeAI/lib/sync/types.ts](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/lib/sync/types.ts)

### Done when

- My Day Firestore paths are frozen
- canonical My Day document schemas are defined

---

## Phase 3: Add My Day Sync Modules

### Goal

Bring My Day into the sync system.

### Work

#### 3.1 Add `MyDayProfileSync`

Responsibilities:

- load local cache
- normalize local profile
- pull remote profile
- resolve conflicts
- push local dirty profile
- mark profile dirty on save

#### 3.2 Add `MyDayMealsSync`

Responsibilities:

- load local meal cache
- normalize meals
- pull remote meal collection
- push dirty local meal mutations
- support add / update / delete

#### 3.3 Add `MyDayWeightSync`

Responsibilities:

- load local weight cache
- pull remote weight collection
- push local mutations
- support add / update / delete

#### 3.4 Register modules in `SyncEngine`

Extend [SyncEngine.ts](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/lib/sync/SyncEngine.ts) to orchestrate:

- recipes
- cookbooks
- preferences
- My Day profile
- My Day meals
- My Day weights

#### 3.5 Add dirty-mark helpers

Add to sync engine:

- `markMyDayProfileDirty(...)`
- `markMyDayMealDirty(...)`
- `markMyDayMealDeleted(...)`
- `markMyDayWeightDirty(...)`
- `markMyDayWeightDeleted(...)`

### Files likely involved

- new:
  - `frontend/RecipeAI/lib/sync/MyDayProfileSync.ts`
  - `frontend/RecipeAI/lib/sync/MyDayMealsSync.ts`
  - `frontend/RecipeAI/lib/sync/MyDayWeightSync.ts`
- updated:
  - [frontend/RecipeAI/lib/sync/SyncEngine.ts](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/lib/sync/SyncEngine.ts)
  - [frontend/RecipeAI/lib/sync/types.ts](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/lib/sync/types.ts)

### Done when

- My Day no longer depends only on local AsyncStorage
- My Day writes are prepared for sync

---

## Phase 4: Wire My Day Screens To Sync

### Goal

Make the actual UI write through the sync-aware domain layer.

### Work

#### 4.1 Health & Goals

When saving Health & Goals:

- update local cache
- mark profile dirty
- trigger sync

#### 4.2 Meal logging

When adding/editing/deleting meals:

- write through sync-aware storage
- mark meal dirty / deleted
- keep local UX immediate
- sync asynchronously

#### 4.3 Weight logging

When adding/editing/deleting weight entries:

- update sync-aware cache
- mark weight log dirty / deleted

### Files likely involved

- [frontend/RecipeAI/app/(tabs)/my-day.tsx](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/app/(tabs)/my-day.tsx)
- [frontend/RecipeAI/app/(tabs)/my-day/history.tsx](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/app/(tabs)/my-day/history.tsx)
- [frontend/RecipeAI/app/(tabs)/profile.tsx](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/app/(tabs)/profile.tsx)
- [frontend/RecipeAI/lib/myDay.ts](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/lib/myDay.ts)
- [frontend/RecipeAI/lib/myDayMeals.ts](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/lib/myDayMeals.ts)
- [frontend/RecipeAI/lib/myDayWeight.ts](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/lib/myDayWeight.ts)

### Done when

- My Day screens read/write through sync-aware paths
- local UX remains immediate
- data survives device/account transitions through Firestore

---

## Phase 5: Recipe And Cookbook Model Cleanup

### Goal

Reduce legacy snapshot bridging and make recipes/cookbooks more canonical.

### Current problem

Recipes and cookbooks still rely on:

- legacy snapshot keys
- sync-store keys
- snapshot publishing back and forth

This is a migration bridge, not a good long-term model.

### Work

#### 5.1 Make sync-store the only canonical local cache

Move UI away from:

- `recipes`
- `cookbooks`

and toward:

- sync-aware repository reads

#### 5.2 Remove snapshot mirroring gradually

Keep compatibility temporarily, but phase out:

- `saveLocalRecipesSnapshot(...)`
- `saveLocalCookbooksSnapshot(...)`

once screens no longer rely on legacy keys

#### 5.3 Ensure newer recipe fields are canonical

Recipe sync model must explicitly include:

- `nutritionInfo`
- `mealLoggingRepresentation`
- any future AI/import metadata

### Done when

- recipes/cookbooks no longer depend on legacy AsyncStorage snapshots
- sync-store is the only local canonical cache

---

## Phase 6: Account Transition Behavior

### Goal

Make auth transitions deliberate and predictable.

### Rules to enforce

#### 6.1 Anonymous -> linked signup/login

- keep same uid
- no merge required
- sync continues normally

#### 6.2 Anonymous -> login to different existing account

- do not auto-merge guest data
- switch local cache to signed-in account data
- guest data remains under old anonymous uid

#### 6.3 Logout

- clear local caches
- clear pending mutation queues
- stop listeners
- start fresh anonymous user

### Future option

Later we may add:

- explicit guest-data import flow

but not in the initial refactor.

### Files likely involved

- [frontend/RecipeAI/context/AuthContext.tsx](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/context/AuthContext.tsx)
- [frontend/RecipeAI/lib/sync/SyncEngine.ts](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/lib/sync/SyncEngine.ts)

### Done when

- account transitions behave predictably
- there is no accidental cross-account local data bleed

---

## Phase 7: Direct Firestore Migration

### Goal

Move standard sync domains from backend-mediated sync to direct Firestore access where appropriate.

### Scope

Target domains:

- recipes
- cookbooks
- preferences
- My Day profile
- My Day meals
- My Day weights

Non-target domains:

- economy
- rewards
- premium actions
- purchases

### Work

#### 7.1 Add repository layer

For each domain:

- Firestore read/write adapter
- local cache adapter
- normalizer
- merge strategy

#### 7.2 Introduce Firestore listeners where useful

Use snapshot listeners selectively for:

- preferences
- recipes/cookbooks if we want multi-device freshness
- My Day profile

Meals/weights can start with fetch + push if we want to avoid listener complexity first.

#### 7.3 Keep backend paths only where needed

Do not move economy to direct Firestore.

### Done when

- normal user-owned data no longer needs the backend as a relay
- backend load is reduced

---

## Phase 8: Legacy Removal And Stabilization

### Goal

Finish cleanup after the new model is proven.

### Work

- remove deprecated sync endpoints if no longer needed
- remove legacy AsyncStorage snapshot dependence
- remove compatibility-only uid fallbacks
- clean stale migration helpers
- document final Firestore schema

### Done when

- one sync architecture remains
- documentation matches production behavior

---

## Testing Strategy

Each phase should be validated across these cases:

### Auth cases

- anonymous first launch
- anonymous creates data
- anonymous links account
- anonymous logs into different existing account
- logged-in user logs out

### Network cases

- online create/update/delete
- offline create/update/delete then reconnect
- interrupted sync

### Multi-device cases

- same signed-in account on 2 devices
- stale local cache on one device

### Domain cases

- recipes
- cookbooks
- preferences
- My Day profile
- My Day meals
- weight logs
- economy remains correct and isolated

---

## Recommended Execution Order

If we start implementing now, I recommend this order:

1. Phase 1: identity hardening
2. Phase 2: My Day Firestore model
3. Phase 3: My Day sync modules
4. Phase 4: My Day screen wiring
5. Phase 6: account transition tightening
6. Phase 5: recipe/cookbook cleanup
7. Phase 7: direct Firestore migration
8. Phase 8: cleanup

This order gives us correctness first, then product-value sync coverage, then scalability cleanup.

---

## Recommended Immediate Next Coding Task

Start with:

### Task A

Harden recipe and cookbook sync auth so the backend derives uid from the verified Firebase token.

### Task B

Define and add types for:

- `MyDayProfileDoc`
- `MyDayMealDoc`
- `MyDayWeightDoc`

Those are the safest next concrete steps because they improve security and set up My Day sync cleanly.

