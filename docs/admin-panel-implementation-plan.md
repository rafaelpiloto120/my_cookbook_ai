# Cook N'Eat Admin Panel Implementation Plan

## Goal

Build a private, lightweight admin and support system for Cook N'Eat that helps us understand users, capabilities, AI usage, economy state, and troubleshooting history without breaking or slowing the application.

The admin system must be additive. The mobile app's current source-of-truth paths must keep working exactly as they do today.

## Non-Breaking Rules

1. Do not move existing user data.
2. Do not make the mobile app depend on admin-only collections.
3. Do not replace `users/{uid}/economy/default` as the source of truth for eggs/cookies or free premium actions.
4. Do not allow raw arbitrary Firestore edits from the admin UI.
5. Admin writes must go through server-side endpoints, update the existing source-of-truth documents, write ledger entries where relevant, and write admin audit logs.
6. Dashboard reads should use summaries and indexes, not live scans of all user subcollections.

## Current State Review

### Existing Source-Of-Truth Paths

The current app stores user-owned data under:

```txt
users/{uid}/recipes/{recipeId}
users/{uid}/cookbooks/{cookbookId}
users/{uid}/preferences/default
users/{uid}/myDay/profile/default
users/{uid}/myDayMeals/{mealId}
users/{uid}/myDayWeights/{weightId}
users/{uid}/economy/default
users/{uid}/economy/default/ledger/{entryId}
```

Note: the architecture docs describe future/target My Day paths as `users/{uid}/myDay/meals` and `users/{uid}/myDay/weights`, but the current backend code still uses `users/{uid}/myDayMeals` and `users/{uid}/myDayWeights` for legacy sync endpoints. Admin work should observe both naming realities and avoid migrations in the first phase.

### Economy Ledger

The economy ledger already exists:

```txt
users/{uid}/economy/default/ledger/{entryId}
```

It records grants and spends with fields such as:

```txt
uid
delta
balanceAfter
freePremiumActionsAfter
kind
reason
actionKey
source
metadata
createdAt
_serverCreatedAt
```

This should remain the primary troubleshooting source for "why did this user's eggs/free actions change?"

### Analytics / Activity Events

The backend already has generic analytics ingestion:

```txt
POST /analytics-event
POST /events
```

When `ANALYTICS_USE_FIRESTORE` is enabled, events are written to:

```txt
analyticsEvents/{eventId}
```

Existing event coverage includes examples such as:

```txt
ai_suggestions_generated
ai_recipe_generated
import_recipes_from_file
extract_recipe_draft_from_url
import_recipe_from_url
import_recipe_from_url_result
sync_recipes_push_legacy
sync_cookbooks_push_legacy
sync_preferences_write
profile_photo_uploaded
recipe_image_uploaded
recipe_export_pdf
contact_support_sent
economy_purchase_granted
```

This is useful, but it is not yet a canonical admin activity model because event names and metadata are not normalized around capability type, source, status, object path, and user lookup.

### Economy Mission Events

The economy system already records reward/mission progress through:

```txt
POST /economy/events/record
```

Allowed event keys include:

```txt
meal_logged
weight_logged
recipe_added
ai_kitchen_full_recipe_generated
ai_kitchen_suggestions_generated
profile_health_goals_completed
cookbook_created
instagram_reel_imported
```

These are useful for economy rewards, but they are not enough for admin capability reporting because they do not consistently include object ids, object paths, source categories, or failure states.

### Backend Request/Error Logs

The backend uses `console.log`, `console.warn`, and `console.error`, plus local file fallback for analytics when Firestore analytics is disabled.

This is enough for development debugging, but admin/customer support troubleshooting would benefit from structured request/error context:

```txt
requestId
uid
endpoint
env
status
errorCode
durationMs
createdAt
```

This should be improved later without changing user-facing behavior.

### Missing Admin Audit Logs

`adminAuditLogs` does not exist yet. It should be created before any admin mutation tools are enabled.

## Proposed Admin Collections

### `userSummaries/{uid}`

Read-optimized admin snapshot. This is not source of truth.

```txt
uid
email
displayName
isAnonymous
providerIds
createdAt
firstSeenAt
lastSeenAt
firstSeenEnv
lastSeenEnv
lastRealActionAt
lastAppVersion
lastPlatform
recipeCount
mealCount
aiSuggestionCount
aiFullRecipeCount
premiumActionCount
importUrlCount
importFileCount
importInstagramReelCount
cookies
freePremiumActionsRemaining
updatedAt
_serverUpdatedAt
```

Relationship to existing data:

```txt
users/{uid}/economy/default  -> source of truth
userSummaries/{uid}          -> admin/search/dashboard copy
```

The app should not read from `userSummaries`.

### `activityEvents/{eventId}`

Canonical admin/customer activity timeline. This can be written alongside existing `analyticsEvents`, or introduced as a normalized projection from selected existing events.

```txt
uid
email
env
type
action
source
status
objectId
objectPath
requestId
createdAt
clientTs
metadata
```

Recommended `type` values:

```txt
recipe
meal
ai
premium_action
import
economy
auth
support
sync
error
```

Recommended recipe sources:

```txt
manual
url_import
file_import
instagram_reel_import
ai_kitchen
unknown
```

Recommended meal sources:

```txt
manual
describe_meal
photo_log
from_recipe
unknown
```

Recommended statuses:

```txt
attempted
succeeded
failed
blocked
deleted
```

### `aiGeneratedContent/{eventId}`

Searchable archive of AI-generated suggestions and full recipes.

```txt
uid
env
type: "suggestion" | "full_recipe" | "recipe_draft"
title
suggestionId
recipeId
objectPath
language
measurementSystem
model
createdAt
metadata
```

This should intentionally avoid storing excessive prompt/user private data. Store enough for admin review and support, not full sensitive context by default.

### `adminAuditLogs/{logId}`

Immutable audit trail for admin-side reads that mutate data.

```txt
adminUid
adminEmail
adminRole
action
targetUid
targetPath
before
after
reason
requestId
createdAt
_serverCreatedAt
```

Examples:

```txt
economy_grant_eggs
economy_set_eggs
economy_set_free_premium_actions
user_flag_update
```

## Capability Overview

The admin UI should provide a capability overview backed by `activityEvents` and summaries.

Required filters:

```txt
date range
env
uid/email
type
source
status
object id
```

Initial capability cards:

```txt
Recipes added total
Recipes by source
Meals logged total
Meals by source
AI suggestions generated
Full AI recipes generated
Recipe URL imports attempted/succeeded/failed
File imports attempted/succeeded/failed
Instagram Reel imports attempted/succeeded/failed
Premium actions spent by action/source
Active users 7d
Active users 30d
```

Capability rows should link back to the owning user where possible.

## Admin API

Admin API must verify Firebase ID tokens and require an admin custom claim before returning data.

Initial read-only endpoints:

```txt
GET /admin/me
GET /admin/dashboard
GET /admin/users
GET /admin/users/:uid
GET /admin/users/:uid/activity
GET /admin/users/:uid/economy-ledger
GET /admin/activity-events
GET /admin/ai-generated-content
GET /admin/audit-logs
```

Later write endpoints:

```txt
POST /admin/users/:uid/economy/grant-eggs
POST /admin/users/:uid/economy/set-eggs
POST /admin/users/:uid/economy/set-free-premium-actions
```

Every write endpoint must:

1. Verify admin token and role.
2. Validate inputs.
3. Read existing source-of-truth document.
4. Update `users/{uid}/economy/default`.
5. Write `users/{uid}/economy/default/ledger/{entryId}`.
6. Update `userSummaries/{uid}` best-effort.
7. Write `adminAuditLogs/{logId}`.

## Deployment Shape

Current VPS size:

```txt
2 vCPU
4 GB RAM
40 GB disk
```

Use a lightweight custom admin app instead of heavy self-hosted analytics/admin products.

Recommended:

```txt
admin.legnalabs.com
Nginx or Caddy
Node admin API
lightweight React/Next admin UI
Firebase Auth custom claims
Firebase Admin SDK only on server
optional Cloudflare Access or Tailscale gate
```

## Implementation Phases

### Phase 0: Current-State Review

Status: started.

Deliverables:

- confirm existing source-of-truth paths
- confirm current analytics event coverage
- confirm economy ledger shape
- confirm missing admin audit logs
- identify tracking gaps before code changes

### Phase 1: Admin Architecture Doc

Status: this document.

Deliverables:

- admin data model
- non-breaking rules
- endpoint plan
- deployment plan
- capability overview plan

### Phase 2: Read-Only Admin Support Layer

Add only additive helpers/collections:

- normalized activity event writer
- user summary updater
- AI generated content writer

Important: first implementation should be best-effort and fail-open. If admin event writes fail, user-facing actions should still succeed.

### Phase 3: Backfill / Rebuild Scripts

Create scripts that can safely rebuild admin summaries from existing data:

- scan users
- count recipes
- count meals
- copy economy balances
- derive latest activity timestamps where possible

Scripts should be manual/admin-only and not run on app startup.

### Phase 4: Admin Auth Middleware

Add server middleware:

- verify Firebase ID token
- require `admin: true`
- return current admin identity from `/admin/me`

### Phase 5: Read-Only Admin API

Expose read-only endpoints using admin indexes/summaries:

- dashboard totals
- user search/list
- user detail
- activity list
- economy ledger
- AI generated content

No mutations in this phase.

### Phase 6: Lightweight Admin UI

Build:

- login
- dashboard
- users
- user detail
- capability overview
- activity events
- AI generated content
- economy ledger
- audit logs

### Phase 7: Audited Economy Edits

Only after read-only admin works:

- grant eggs
- set eggs
- set free premium actions

These must update the current economy document path and ledger so the app continues to work unchanged.

### Phase 8: Production Deployment

Deploy to Hetzner:

- HTTPS
- environment variables
- service account stored only on server
- process manager or Docker Compose
- optional external access gate

### Phase 9: Statistics

Use Firebase/GA4 -> BigQuery -> Looker Studio for long-term product analytics.

The custom admin panel should be operational/support oriented. Looker Studio should be used for broader trends, cohorts, funnels, and retention.

## First Safe Code Slice After This Plan

The safest implementation slice is:

1. Add a tiny normalized admin activity helper in the backend.
2. Make it best-effort and fail-open.
3. Start writing `activityEvents` for backend-owned actions that already happen server-side:
   - AI suggestions generated
   - AI full recipe generated
   - URL import attempt/result
   - file import result
   - Instagram Reel draft extraction/result
   - premium action spend
4. Do not change the mobile app data model.
5. Do not add admin write endpoints yet.

This gives us better observability first, with the smallest app-risk surface.
