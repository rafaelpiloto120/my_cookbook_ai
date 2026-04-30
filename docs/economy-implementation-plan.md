# Economy Implementation Plan

This plan converts the agreed economy spec into an execution checklist.

Reference:

- [economy-spec.md](/Users/rpiloto/recipe-ai-app/docs/economy-spec.md)

## Primary Goals

1. Add a free premium-action runway.
2. Charge only for premium actions.
3. Deduct only after successful completion.
4. Keep pricing invisible during the free premium runway.
5. Add cookie history in Profile.

## Phase 1: Backend Economy Core

### 1. Update economy constants

File:

- [backend/index.js](/Users/rpiloto/recipe-ai-app/backend/index.js)

Changes:

- update cookie costs:
  - AI Kitchen full recipe: `1`
  - Recipe AI Estimate: `1`
  - Log with photo: `1`
  - Describe meal: `0`
  - Instagram Reel import: `2`
- keep AI Kitchen suggestions: `0`
- update starting cookies and signup bonus only if we later change them from the current `10`
- replace store offers with the new pack structure:
  - `15` for `0.99`
  - `50` for `2.99`
  - `120` for `5.99`
  - `300` for `11.99`

### 2. Extend economy state

File:

- [backend/index.js](/Users/rpiloto/recipe-ai-app/backend/index.js)

Changes:

- add `freePremiumActionsRemaining`
- initialize it for new economy docs
- backfill it safely for older economy docs
- preserve compatibility with existing cookie balance behavior

### 3. Add premium-action consume helper

File:

- [backend/index.js](/Users/rpiloto/recipe-ai-app/backend/index.js)

Changes:

- introduce a unified helper for premium-action consumption
- spend order:
  1. use free premium action if available
  2. else use cookies
  3. else return insufficient balance
- helper should return:
  - source: `free_premium_action` or `cookies`
  - charged cookies
  - remaining cookies
  - remaining free premium actions

### 4. Add cookie ledger

File:

- [backend/index.js](/Users/rpiloto/recipe-ai-app/backend/index.js)

Changes:

- create a ledger write helper
- log:
  - grants
  - spends
  - purchases
  - manual/dev adjustments if they exist
- each entry should include:
  - timestamp
  - delta
  - reason
  - action key when relevant
  - balance after

### 5. Make charging success-only

File:

- [backend/index.js](/Users/rpiloto/recipe-ai-app/backend/index.js)

Changes:

- move premium consumption from “preflight charge” to “post-success commit”
- where necessary, split actions into:
  - precheck eligibility
  - run action
  - commit spend only if usable result exists

This is the most important correctness change.

## Phase 2: Premium Action Enforcement

### 6. AI Kitchen full recipe

Files:

- [backend/index.js](/Users/rpiloto/recipe-ai-app/backend/index.js)
- [frontend/RecipeAI/app/(tabs)/index.tsx](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/app/(tabs)/index.tsx)

Changes:

- keep suggestions free
- charge full recipe only after recipe generation succeeds
- during free premium runway, suppress cookie-cost UI in the flow
- after free runway, show soft cost messaging

### 7. Recipe AI Estimate

Files:

- [backend/index.js](/Users/rpiloto/recipe-ai-app/backend/index.js)
- [frontend/RecipeAI/app/add-recipe.tsx](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/app/add-recipe.tsx)
- [frontend/RecipeAI/app/(tabs)/recipe/[id].tsx](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/app/(tabs)/recipe/[id].tsx)

Changes:

- replace the current pre-charge endpoint model with success-only deduction
- use `1` cookie instead of `2`
- while user still has free premium actions, do not mention cookie deduction

### 8. Describe meal

Files:

- [frontend/RecipeAI/app/(tabs)/my-day.tsx](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/app/(tabs)/my-day.tsx)
- [frontend/RecipeAI/lib/myDayMeals.ts](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/lib/myDayMeals.ts)
- [backend/index.js](/Users/rpiloto/recipe-ai-app/backend/index.js)

Changes:

- add premium enforcement to the AI-backed resolution path
- charge only when the flow successfully produces a reviewable meal draft
- do not charge if parsing/resolution fails

### 9. Log with photo

Files:

- [frontend/RecipeAI/app/(tabs)/my-day.tsx](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/app/(tabs)/my-day.tsx)
- [backend/index.js](/Users/rpiloto/recipe-ai-app/backend/index.js)

Changes:

- add premium enforcement
- charge only when:
  - image is recognized as food
  - ingredients/nutrition are returned
  - review-before-saving can open
- no charge for non-food detection or failed analysis

### 10. Instagram Reel import

Files:

- [backend/index.js](/Users/rpiloto/recipe-ai-app/backend/index.js)
- [frontend/RecipeAI/app/(tabs)/history.tsx](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/app/(tabs)/history.tsx)
- [frontend/RecipeAI/app/cookbook/[id].tsx](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/app/cookbook/[id].tsx)

Changes:

- keep success-only charging
- reduce cost to `2`
- hide pricing during free premium runway
- after free runway, show soft cost messaging

## Phase 3: Rewards

### 11. Signup bonus

File:

- [backend/index.js](/Users/rpiloto/recipe-ai-app/backend/index.js)

Changes:

- preserve current one-time signup bonus behavior
- add ledger entry for the grant

### 12. Complete profile + Health & Goals

Files:

- [frontend/RecipeAI/app/(tabs)/profile.tsx](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/app/(tabs)/profile.tsx)
- [frontend/RecipeAI/app/(tabs)/my-day.tsx](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/app/(tabs)/my-day.tsx)
- [backend/index.js](/Users/rpiloto/recipe-ai-app/backend/index.js)

Changes:

- define completion criteria
- trigger a one-time grant
- write grant marker + ledger entry

### 13. First recipe saved

Files:

- [frontend/RecipeAI/app/add-recipe.tsx](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/app/add-recipe.tsx)
- [backend/index.js](/Users/rpiloto/recipe-ai-app/backend/index.js)

Changes:

- grant once on first successful recipe save
- add ledger entry

### 14. First meal logged

Files:

- [frontend/RecipeAI/app/(tabs)/my-day.tsx](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/app/(tabs)/my-day.tsx)
- [backend/index.js](/Users/rpiloto/recipe-ai-app/backend/index.js)

Changes:

- grant once on first successful meal save
- add ledger entry

### 15. First cookbook created

Files:

- [frontend/RecipeAI/app/add-recipe.tsx](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/app/add-recipe.tsx)
- [frontend/RecipeAI/app/(tabs)/history.tsx](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/app/(tabs)/history.tsx)
- [backend/index.js](/Users/rpiloto/recipe-ai-app/backend/index.js)

Changes:

- identify the first real custom cookbook creation moment
- grant once
- add ledger entry

## Phase 4: Frontend UX

### 16. Hide pricing during free premium runway

Files likely impacted:

- [frontend/RecipeAI/app/(tabs)/index.tsx](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/app/(tabs)/index.tsx)
- [frontend/RecipeAI/app/add-recipe.tsx](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/app/add-recipe.tsx)
- [frontend/RecipeAI/app/(tabs)/recipe/[id].tsx](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/app/(tabs)/recipe/[id].tsx)
- [frontend/RecipeAI/app/(tabs)/history.tsx](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/app/(tabs)/history.tsx)
- [frontend/RecipeAI/app/cookbook/[id].tsx](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/app/cookbook/[id].tsx)
- [frontend/RecipeAI/app/(tabs)/my-day.tsx](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/app/(tabs)/my-day.tsx)

Changes:

- do not show cost hints if `freePremiumActionsRemaining > 0`
- keep cookie info visible only in:
  - Profile
  - FAQ
  - Store

### 17. Smooth post-runway messaging

Same screens as above.

Changes:

- once free premium actions are exhausted:
  - show subtle cost messaging before premium actions
  - keep language calm and helpful
- recommended style:
  - `This uses 1 cookie`
  - `This uses 1 cookie`

### 18. Insufficient-cookies recovery flow

Files:

- [frontend/RecipeAI/app/economy/store.tsx](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/app/economy/store.tsx)
- all insufficient-cookies modal surfaces

Changes:

- feature the `50 cookies` pack as the primary recovery offer
- visually highlight it as discounted / recommended
- minimize steps from blocked action to purchase flow

### 19. Profile cookie history

Files:

- [frontend/RecipeAI/app/(tabs)/profile.tsx](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/app/(tabs)/profile.tsx)
- [backend/index.js](/Users/rpiloto/recipe-ai-app/backend/index.js)

Changes:

- add `Cookies history` access from Profile > Cookies
- show:
  - date/time
  - amount added/deducted
  - reason
  - optional balance after

## Phase 5: Copy / Content Audit

### 20. Update outdated cookie copy

Files:

- [frontend/RecipeAI/i18n.ts](/Users/rpiloto/recipe-ai-app/frontend/RecipeAI/i18n.ts)

Known issues to review:

- suggestions copy should not imply suggestions cost cookies
- onboarding copy should reflect free premium actions
- insufficient-cookie copy should match new action costs
- store copy should match new packs

## Suggested Execution Order

If we want the safest path:

1. backend economy state + helper
2. success-only charge model
3. recipe AI Estimate migration
4. AI Kitchen full recipe migration
5. Describe meal enforcement
6. Log with photo enforcement
7. rewards
8. store packs
9. profile cookie history
10. final copy audit

## Immediate Recommendation

The best next implementation step is:

- **Phase 1: Backend Economy Core**

That is the foundation for everything else. Without it, the frontend UX changes would be cosmetic and fragile.
