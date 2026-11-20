# Homie API

Mobile app API lives under `/api/app`; the back-office API under `/api/admin-homie` (admin token from `POST /api/admin-auth/login`).
All responses are `{ success, message?, data? }`. Authenticated routes need `Authorization: Bearer <accessToken>`.

## Run it
```bash
cd server
npm run db:migrate          # runs all migrations (also runs automatically on `npm start`)
npm run homie:seed          # 6 verified demo chefs (phones +2348000000001 … 06)
npm run admin:ensure        # creates the default admin (see scripts/ensureAdmin.js)
npm run dev                 # http://localhost:8082
```
In development with `SMS_PROVIDER=console`, `POST /auth/otp/request` returns the code as `data.devCode`.

## Money rules
Hirer pays the booking total (chef fee + groceries) → held in escrow → released on approval (or auto-release after
`HOMIE_AUTO_RELEASE_HOURS`). Homie keeps `HOMIE_COMMISSION_RATE` (10%) of the total; the chef gets the rest.
Cancel/decline before check-in = full refund. A reported problem freezes the funds until staff resolve it.

## Booking lifecycle
`awaiting_payment → pending_chef → confirmed → in_progress → awaiting_approval → completed`
Side exits: `cancelled`, `declined`, `expired`, `disputed → completed|cancelled`.

## App endpoints (`/api/app`)
| | |
|---|---|
| `POST /auth/otp/request` `{phone\|email}` · `POST /auth/otp/verify` `{phone\|email, code, role?}` | sign in / up (returns `accessToken`, `refreshToken`, `member`, `isNewUser`) |
| `POST /auth/refresh` `{refreshToken}` · `POST /auth/logout` | rotate tokens / sign out |
| `POST /me/email/request` `{email}` · `POST /me/email/verify` `{email, code}` | change email (code-verified; `PATCH /me` cannot change it) |
| `GET /me` · `PATCH /me` · `POST /me/role` `{role}` · `POST /me/push-token` `{token}` | profile, role switch, Expo push token |
| `GET /chefs?q&cuisine&maxDistance&minRating&sort=rating\|distance\|price\|popular&lat&lng&page&limit` | search (verified chefs only) |
| `GET /chefs/:id` · `/chefs/:id/reviews` · `/chefs/:id/availability?from&to` | profile, reviews, unavailable days |
| `GET /favorites` · `PUT\|DELETE /favorites/:chefId` | favorites |
| `POST /bookings` `{chefId, serviceId, scheduledAt, guests, address, groceries?, notes?, quantity?}` | create (`awaiting_payment`) |
| `POST /bookings/:id/pay` → `{authorizationUrl, reference}` · `GET /payments/verify/:reference` | Paystack checkout (open `authorizationUrl` in a WebView, then verify) |
| `GET /bookings?as=hirer\|chef&status=active\|past` · `GET /bookings/:id` | lists / detail |
| Hirer: `POST /bookings/:id/approve\|cancel\|report\|review` | approve & release, cancel, report problem `{reason}`, review `{rating, comment}` |
| Chef: `POST /bookings/:id/accept\|decline\|check-in\|complete` | job workflow |
| `GET /chat/threads?as=` · `POST /chat/threads {chefId}` · `GET\|POST /chat/threads/:id/messages` | chat (also realtime, below) |
| `GET /notifications` · `POST /notifications/read` · `POST /notifications/:id/read` | in-app notifications |
| Chef setup: `GET\|PUT /me/chef` · `PUT /me/chef/services` · `PUT /me/chef/availability` · `PUT /me/chef/payout-account` · `POST /me/chef/verification` · `GET /me/chef/earnings` · `GET /banks` | become a chef, menu/pricing, calendar, payout bank, ID check, earnings |
| `POST /uploads?kind=avatar\|portfolio\|verification` (multipart `file`) | Cloudinary image upload |
| `POST /payments/webhook` | Paystack webhook (signature-verified). Set it in the Paystack dashboard. |

**Realtime:** connect Socket.IO to the server root with `auth: { token: accessToken }`. Events: `chat:message` (server→client), `chat:typing` (both ways, `{threadId, isTyping}`).

## Admin endpoints (`/api/admin-homie`)
`GET /overview` · `GET /users[?type&status&q]` · `GET /users/:id` · `PATCH /users/:id/status` · `GET /verifications` ·
`POST /verifications/:chefId/decision {approve, note}` · `GET /bookings` · `GET /bookings/:id` · `GET /payments/issues` ·
`POST /payments/:id/retry-payout|retry-refund` · `GET /disputes` · `POST /disputes/:id/review|resolve {resolution: release|refund|split, splitPercentToChef, note}` ·
Disputes on bookings above `HOMIE_DUAL_APPROVAL_THRESHOLD` (₦50,000) need two different admins: the first `resolve` call returns 202 and saves a proposal; a second admin sending the same outcome executes it. · `GET /moderation/flags` · `POST /moderation/flags/:id/review` · `GET /settings` · `GET /audit-log`

## Known gaps
- OTP SMS needs a real provider (`SMS_PROVIDER=termii` is wired but untested) — `console` only logs.
- Staff management / custom roles, support tickets, promo codes and city management are not built.
- Refresh tokens allow one signed-in device per account (a new sign-in revokes the old one).
