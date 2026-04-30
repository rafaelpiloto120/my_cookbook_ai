# Economy Spec

## Goal

Keep the app broadly free and habit-friendly while charging only for the AI actions that create meaningful backend cost.

The economy should:

- feel generous during onboarding;
- avoid ads;
- keep daily tracking flows free;
- make premium AI actions affordable and easy to understand;
- be simple enough to implement now without subscriptions.

## Principles

1. Core product usage stays free.
2. Only genuinely costly AI actions are premium.
3. New users get enough free premium usage to understand the app's value.
4. Premium actions should usually cost 1 cookie.
5. Cookie packs should feel generous enough that one action does not feel expensive.
6. Rewarded cookies should reinforce activation and retention, not gambling-like behavior.
7. During the free premium runway, pricing should stay mostly invisible in action flows.
8. Cookies should only be deducted when the premium action has actually succeeded.

## Premium Actions

These actions are considered premium and should consume either a free premium action or cookies.

| Action | Premium | Cookie Cost | Rationale |
|---|---:|---:|---|
| AI Kitchen full recipe generation | Yes | 1 | Valuable AI generation, but should stay accessible |
| Recipe AI Estimate | Yes | 1 | Clear user value, moderate backend cost |
| Log with photo | Yes | 1 | Vision call, premium-feeling feature |
| Describe meal / ingredient resolution | No | 0 | Core meal logging flow; should stay free to protect retention |
| Instagram Reel import | Yes | 2 | Heaviest feature due to extraction + AI |

## Free Actions

These actions should remain free and never consume free premium actions or cookies.

| Action | Reason |
|---|---|
| AI Kitchen suggestions | Acquisition / delight; helps user reach premium generation |
| Standard recipe URL import | Keep broad recipe capture accessible |
| Add meal from recipe | Logging an already-existing recipe should feel free |
| Editing meals, recipes, cookbooks | Core product usage |
| My Day tracking, history, profile, Health & Goals | Core retention behavior |
| Recipe/image upload and sync behavior | Infra cost exists, but should not be explicitly monetized |

## Onboarding Economy

### Free Premium Actions

Every user gets:

- **25 free premium actions**

Rationale:

- generous enough to explore the premium parts of the app;
- close to roughly one week of engaged early usage;
- not so high that monetization feels indefinitely postponed.

### Onboarding UX Rule

During the first 25 free premium actions:

- do **not** show cookie-cost warnings in premium action flows;
- do **not** tell the user that cookies will be deducted;
- keep the premium experience feeling open and unconstrained;
- allow cookie explanations only in Profile, FAQ, and Store.

### Starting Cookies

Every new user / device gets:

- **10 starting cookies**

Rationale:

- keeps the current baseline;
- gives continued value after the free premium actions are exhausted;
- simple to explain.

## Reward Cookies

These rewards should be granted once per user unless stated otherwise.

| Trigger | Reward | Notes |
|---|---:|---|
| First real account creation / first non-anonymous login | +10 | Existing behavior is close to this already |
| Complete profile + Health & Goals | +3 | Good activation milestone |
| First recipe saved | +2 | Encourages cookbook setup |
| First meal logged | +2 | Encourages My Day habit |
| First cookbook created | +3 | Encourages organization / retention |

### Total Early Value

A fully activated new user can receive:

- 25 free premium actions
- 10 starting cookies
- +10 create account
- +3 profile + Health & Goals
- +2 first recipe saved
- +2 first meal logged
- +3 first cookbook created

That means:

- **25 free premium actions**
- **30 cookies total** if they complete the core milestones

## Cookie Packs

The current packs make each action feel too expensive. The new direction should make 1 cookie feel like a small in-app action, not a major purchase.

### Proposed Packs

| Pack | Price (USD) | Notes |
|---|---:|---|
| 15 cookies | 0.99 | Low-friction top-up |
| 50 cookies | 2.99 | Best everyday value |
| 120 cookies | 5.99 | Power-user pack |
| 300 cookies | 11.99 | Heavy-user pack |

### Store Positioning

| Pack | Positioning |
|---|---|
| 15 cookies | Starter |
| 50 cookies | Most purchased |
| 120 cookies | Best value |
| 300 cookies | Biggest pack |

## Spend Order

When a user triggers a premium action, the app should apply spend in this order:

1. If action is not premium: allow for free.
2. If `freePremiumActionsRemaining > 0`: consume one free premium action.
3. Else if `cookies >= cookieCost`: spend cookies.
4. Else: block and show insufficient-cookies UI.

This order is important because the onboarding promise should feel real.

## Charge Timing

Cookies must only be deducted when the premium action has actually succeeded.

Do not charge on:

- tap;
- modal open;
- upload start;
- action start;
- failed or unusable AI output.

Only charge when the user receives the intended value.

### Examples

Charge only after:

- AI Kitchen full recipe has been successfully generated;
- Recipe AI Estimate has successfully returned usable nutrition;
- Log with photo has successfully returned a reviewable food result;
- Describe meal has successfully returned a reviewable ingredient interpretation;
- Instagram Reel import has successfully produced a high-quality recipe draft.

If a premium flow fails, times out, or returns unusable output:

- do not deduct cookies;
- do not consume a free premium action;
- show a retry-friendly error state.

## State Model

Recommended economy state additions:

```ts
type EconomyState = {
  cookies: number;
  freePremiumActionsRemaining: number;
  grants: {
    signup_bonus_v1?: { amount: number; at: number };
    complete_profile_health_goals_v1?: { amount: number; at: number };
    first_recipe_saved_v1?: { amount: number; at: number };
    first_meal_logged_v1?: { amount: number; at: number };
    first_cookbook_created_v1?: { amount: number; at: number };
  };
  lastSpend?: {
    action: string;
    source: "free_premium_action" | "cookies";
    amount: number;
    at: number;
  };
  updatedAt: number;
};
```

## Premium Action Keys

Recommended canonical action keys:

- `ai_recipe_full`
- `recipe_nutrition_estimate`
- `meal_photo_log`
- `describe_meal`
- `import_instagram_reel`

## Backend Enforcement Plan

### Existing charged actions

Currently charged:

- full AI recipe generation;
- recipe nutrition estimate;
- Instagram Reel import.

### New premium actions to enforce

Need premium enforcement added for:

- Log with photo;
- Describe meal / ingredient resolution.

### Deduction helper

Introduce a single helper for premium actions that:

- knows the premium action key;
- knows cookie cost;
- applies the spend order;
- returns a normalized economy response.

Suggested behavior:

```ts
consumePremiumAction({
  req,
  action: "describe_meal",
  cookieCost: 1,
})
```

Return shape:

```ts
{
  ok: true,
  source: "free_premium_action" | "cookies",
  charged: 0 | number,
  remainingCookies: number,
  remainingFreePremiumActions: number,
}
```

Or on failure:

```ts
{
  ok: false,
  error: "insufficient_cookies",
  requiredCookies: number,
  remainingCookies: number,
  remainingFreePremiumActions: number,
}
```

### Transactional requirement

The premium-action consumption step must happen only after success is confirmed, or in a commit step that is reached only when the action has produced a usable result.

## Reward Trigger Plan

### Trigger: complete profile + Health & Goals

Grant when:

- profile basics are complete enough;
- Health & Goals has a valid plan / target setup.

### Trigger: first recipe saved

Grant on the first successful user-created or imported recipe save.

### Trigger: first meal logged

Grant on the first successful save into My Day.

### Trigger: first cookbook created

Grant on the first successful cookbook creation.

### Idempotency

Each reward must:

- be granted once;
- use a stable grant key in `economy.grants`;
- be safe against retries.

## UX / Copy Direction

### Key onboarding message

Use this message prominently:

- **Your first 25 premium actions are free**

Supporting messages:

- Create an account to get +10 cookies
- Complete your setup to earn more cookies

### During free premium actions

Do not foreground pricing in the main action flows.

Avoid during the free runway:

- "This costs X cookies"
- "X cookies will be deducted"
- "You have Y cookies remaining"

The user should discover the value of the premium actions before feeling pricing friction.

### Premium explanation

Avoid saying "AI features cost cookies" generically.

Prefer:

- Cookies are used only for premium AI actions
- Everyday tracking and organization stay free

### After free premium actions are exhausted

Once the user has no free premium actions remaining:

- begin showing smooth pre-action cost messaging;
- prefer inline notices over harsh blocking language;
- keep the tone calm and helpful.

Recommended wording style:

- "This uses 1 cookie"
- "This uses 1 cookie"

### Insufficient balance UI

When user has no free premium actions left and insufficient cookies:

- show the action cost;
- show remaining cookies;
- show free premium actions remaining if any;
- route to store.

### Recovery offer

When the user is out of cookies and attempts a premium action:

- offer an immediate recovery path;
- highlight a featured discounted pack;
- reduce the number of steps needed to continue.

Recommended featured recovery pack:

- **50 cookies with 25% discount**

This should be the most prominent offer in insufficient-cookies moments.

## Cookie Ledger / History

Users should be able to inspect their cookie history from:

- **Profile > Cookies**

### Ledger entry fields

| Field | Description |
|---|---|
| Date / time | When the change occurred |
| Delta | Positive or negative cookie amount |
| Reason | Why cookies were added or deducted |
| Source type | Reward, premium action, purchase, manual grant, etc. |
| Balance after | Optional but recommended |

### Example reasons

- Starting cookies
- Account creation bonus
- Completed Health & Goals
- First recipe saved
- First meal logged
- First cookbook created
- Full AI recipe generation
- Recipe AI Estimate
- Log with photo
- Describe meal
- Instagram Reel import
- Cookie purchase

### Suggested data model

```ts
type EconomyLedgerEntry = {
  id: string;
  uid: string;
  delta: number;
  balanceAfter?: number;
  kind: "grant" | "spend" | "purchase" | "adjustment";
  reason: string;
  actionKey?: string | null;
  createdAt: number;
  metadata?: Record<string, unknown>;
};
```

This ledger is important for:

- user trust;
- support/debugging;
- pricing analysis over time.

## Screens / Flows Impacted

Frontend copy and behavior will need review in:

- AI Kitchen suggestions/full recipe screens
- Add Recipe AI Estimate
- Recipe Details AI Estimate
- My Day > Add meal > Describe meal
- My Day > Add meal > Log with photo
- Instagram Reel import flows
- Profile cookie info
- Profile cookie history / ledger
- Store UI
- insufficient-cookies modals
- onboarding hints / FAQs

## Rollout Plan

### Phase 1

- update economy constants;
- add `freePremiumActionsRemaining`;
- implement spend-order logic;
- keep current premium actions working;
- add premium enforcement to Describe meal and Log with photo.

### Phase 2

- add reward triggers;
- add economy ledger entries;
- update store packs;
- refresh UI copy.

### Phase 3

- review analytics;
- adjust pack sizes or cookie costs if needed.

## Open Questions

These still need product confirmation before code changes:

1. Is `25` the final number for free premium actions?
2. Are the cookie pack sizes/prices final, or only directional?
3. Should Log with photo and Describe meal both be exactly 1 cookie?
4. Should any weekly refill exist, or only milestone rewards for now?

## Recommended Default Decisions

If we want to move without reopening discussion, use:

- free premium actions: **25**
- starting cookies: **10**
- signup bonus: **10**
- profile + Health & Goals: **3**
- first recipe saved: **2**
- first meal logged: **2**
- first cookbook created: **3**

Cookie costs:

- full AI recipe: **1**
- Recipe AI Estimate: **1**
- Log with photo: **1**
- Describe meal: **0**
- Instagram Reel import: **2**

Cookie packs:

- 15 for 0.99
- 50 for 2.99
- 120 for 5.99
- 300 for 11.99
