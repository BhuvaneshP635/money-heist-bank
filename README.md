# Money Heist Bank — integrated P635 portal

This project extends the supplied `money-heist-bank-main` Vite/React application. It keeps the original Central Bank transfer client and Worker URL, and adds the customer/admin portal around that same bank identity.

## Existing architecture retained

- Bank identity: `P635` / `BHUV0M8F4JQ` (`src/bank-config.js`).
- Bank Firebase project: `money-heist-bank-p635` (set in `.env.local`).
- Central Switch Registry: `sharedbank-connect` is separate from the bank Firebase project.
- Central Bank Worker: `https://sharedbank-switch.e-commerce-sriramtpsiog.workers.dev` (`src/cloudflare-config.js`).
- The original `src/live-api.js`, `src/cloudflare-config.js`, and `src/amount.js` are retained unchanged.
- Transfers continue to use the existing Worker endpoints: bank sign-in, dashboard, and transfers. The transfer reservation/credit/commit flow is not reimplemented in the browser.

## Features added

- Customer registration with field validation and Firebase Authentication account creation.
- Customer profile creation and editable contact/address fields.
- Customer sign-in through Firebase Authentication plus the existing P635 Worker `/sign-in` endpoint. The returned Worker identity is checked against the Firebase UID.
- Persisted auth session with Firebase refresh-token renewal.
- Customer dashboard reads account balances and transfer activity from the existing Worker `/dashboard` endpoint.
- Existing `LiveBank.jsx` transfer flow is embedded in the authenticated portal and receives the shared app session; it no longer asks customers to sign in a second time.
- Admin sign-in verifies `admins/{uid}` in the bank Firebase project.
- Admin customer/account overview and loan review queue.
- Customer loan application form, scoped application history, EMI estimate, and review status.
- Firestore security rules that prevent browser-side account, balance, ledger, audit, and admin writes.

## Setup

1. Use Node.js 22 or newer.
2. Copy `.env.example` to `.env.local`.
3. Set `VITE_FIREBASE_API_KEY` to the Web API key for `money-heist-bank-p635`; confirm `VITE_FIREBASE_PROJECT_ID` is exactly that project.
4. Ensure Email/Password Authentication is enabled in that Firebase project.
5. Deploy `firestore.rules` to the `money-heist-bank-p635` Firestore database.
6. Run `npm ci`, then `npm run dev`.
7. Verify with `npm run build` before publishing.

## Important backend boundaries (not falsely simulated)

The supplied Central Bank Worker exposes bank sign-in, dashboard, and transfer operations. The supplied source does **not** expose trusted public endpoints for:

- allocating/provisioning a new P635 account from the registration flow;
- blocking/suspending an account with audit logging;
- loan disbursement and ledger posting;
- loan repayment posting and repayment verification.

Therefore registration creates the Firebase identity and customer profile, but account provisioning remains pending until an authorized operator provisions or attaches an account using the supplied trusted owner CLI (`support/worker/tools/configure.mjs account ...`) or a new Worker endpoint is deployed. The dashboard shows this state. The CLI requires authorized `gcloud` credentials and an already allocated account ID/number; do not run it with guessed account identifiers. Admin account status changes and loan disbursement are not simulated in the browser.

### Required future Worker contracts

1. `POST /api/v1/banks/P635/accounts/provision` — authenticated customer/admin authorization, deterministic/idempotent account allocation, create zero-balance account with `customerUid`, `isSynthetic: true`, `currency: INR`, `postedBalanceMinor: 0`, `heldMinor: 0`, and audit event.
2. `POST /api/v1/banks/P635/accounts/{accountId}/status` — admin authorization, allowed status transition, immutable audit event.
3. `POST /api/v1/banks/P635/loans/disburse` — admin authorization, idempotency key, atomic account credit + immutable `LOAN_DISBURSEMENT` ledger entry + loan status update to `DISBURSED`.
4. Trusted repayment endpoint — idempotent debit/settlement, repayment ledger entries, and repayment schedule/status update.

Do not implement any of these financial operations as direct browser Firestore writes. The Worker must perform them with server-side credentials and transaction/reconciliation controls.

## Admin bootstrap

Create `admins/{firebaseUid}` only through a trusted Firebase Admin SDK / authorized operator process, with at least `{ active: true }`. The browser cannot create or modify admin records. Keep `.env.local`, service-account JSON, and other credentials out of Git.

## SharedBank owner patch files

The `support/`, `bin/`, `lib/`, `bank.sh`, `owner.json`, and `START-HERE.md` files are included from the supplied SharedBank owner patch for authorized operator workflows. Read `START-HERE.md` before running any command. Do not run owner scripts without the required project permissions and credentials.
