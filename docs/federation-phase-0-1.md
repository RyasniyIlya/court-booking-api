# Federation partnership: phase 0 and phase 1

Local implementation started on 2026-10-06. No API push, production migration,
production backfill or federation write endpoints have been performed.

## Defaults for the following phases

- Initial squash rating: 1200. Federation import can replace it through an audited import.
- Singles, PAR-11, best of five games.
- Interclub games do not affect federation ELO by default.
- ELO calculation, federation permissions, tournament creation UI and leaderboards remain phase 2–4 work.
- Existing padel SkillLevel is unchanged. Squash manual levels use separate fields.

## Phase 1: schema foundation prepared

Additive migration: `20261006120000_federation_rating_foundation`.
Existing customers/entries have nullable playerId; existing bookings default to CLUB.
There is no automatic rewrite of old customer records.

- Player: unique normalized phone, name, phoneVerifiedAt, federation ELO and match counter,
  automatic/manual level source and optional manual level, federation membership/code.
  Federation ID identifies the organization; federationPlayerCode identifies its player.
- ClubPlayerRating: composite club/player key, ELO, match count, last match and club manual level.
- Federation: name/code/logo, no new public or club mutation endpoints.
- ClubFederation: partnership with a specific federation, PENDING/CONFIRMED/REVOKED and confirmation actor/time.
- Booking: tournamentScope, federationId/code, unique code within federation and participating clubs.
- TournamentClub: relational interclub membership.
- TournamentEntry: explicit optional Player relation, independent of Customer; legacy free-text/pair entries remain supported.
- RatingChange: before/after rating, match counts and last-match timestamps, actor/reason,
  match version, calculation version, effective time, unique idempotency key and reversal relation.
  Database trigger prevents content UPDATE/DELETE; corrections append events. Scope constraint requires a club
  for club events and no club for federation events. Player deletion cannot erase audit history.
  matchId is an immutable identifier; optional matchRefId is a live foreign key that clears when
  a match is removed. Clearing only this live reference is the sole permitted update, so existing
  booking retention can continue without deleting or changing rating history.

Manual ELO changes will update the same ELO value and append MANUAL events, rather than maintain
a second competing ELO value. Manual *level* is stored independently and has its own source.
The Player field models a single federation rating per player; supporting several independent
federation ratings would require another scoped rating table.

`src/lib/players.ts` prepares linking by normalized phone inside a caller-owned transaction.
The caller must pass an authorized clubId. Existing links/names are preserved; invalid numbers,
changed phone/profile mismatches and concurrent edits fail. Linking does not verify ownership
of the number, set phoneVerifiedAt or grant access to another club's data.
The helper is intentionally not called by existing booking/login routes yet.

Activation sequence: review migration → explicitly authorize API push → deploy migration →
dry-run backfill with collision review → connect linking to the agreed customer flows.
Telegram ownership verification and handling shared/reassigned numbers remain explicit follow-up work.

## Phase 0: implemented and measured, budget not yet met

- Route splitting, separate demo widget and admin panel, separate login screen.
- Decorative widget scene loaded only when selected.
- Reduced animation for reduced-motion, slow displays, data-saver, <=2 GB memory or <=2 logical cores.
- Gzip content negotiation for API responses >=1 KB using compression middleware.
- Public tournament DTO cache: 5 seconds, with mandatory revalidation; private routes retain existing cache rules.
- Tournament polling waits for the previous request, pauses while hidden and aborts on unmount.
- Existing customer search is bounded to ten rows and batches pass lookup. Tournament reads already use
  nested Prisma selects and batch queries; no speculative rewrite of write loops or general pagination.
- New foreign-key/rating/federation indices added with the migration.

Before changes, the eager site bundle plus React was approximately 407 KB gzip.
The embed is approximately 138 KB gzip (Vite); the standalone budget script uses Node gzip
and reports about 137 KB because compressor defaults differ.

Measured route JS including static shared imports (decimal KB, Node gzip):

| Route | KB gzip | 150 KB budget |
| --- | ---: | --- |
| Site shell | 77.81 | Pass |
| Demo widget / | 180.19 | Over |
| Club page /c/:slug | 159.62 | Over |
| Admin login | 173.71 | Over |
| Authenticated admin, bundle only | 347.32 | Over |
| Tournament board | 82.43 | Pass |
| Embed widget | 137.39 | Pass |

`court-booking-web/output/performance/bundle-budget.json` is the machine-readable measurement.
`npm run perf:budget` reports results; `npm run perf:budget:strict` fails if any route is over budget.
Run the complete web build (including widget) before either command.
Counts exclude CSS/images/fonts/API; configured decorative scenes can load additional dynamic JS.

Lighthouse JSON files are in `court-booking-web/output/performance/`.
Local production preview + mock API, simulated mobile, CPU slowdown 4x, RTT 300 ms,
throughput 400 Kbps. These are individual simulated runs, not measurements on physical Android hardware.

| Page | LCP | TBT |
| --- | ---: | ---: |
| Club page | 8.81 s | 0 ms |
| Tournament board | 6.05 s | 0 ms |
| Admin login after splitting | 8.50 s | 2.5 ms |

Admin login was 15.37 s in the preceding run before extracting the login screen.
No JavaScript baseline LCP was recorded before the original route splitting, so these values
are not presented as a before/after result for club/tournament pages.
The LCP 2.5 s target is **not achieved**. Authenticated admin interactions and an actual
budget Android device have not been profiled. Fonts and shared UI/styles remain contributors;
further widget/admin splitting, image variants and list profiling are remaining phase 0 work.
No leaderboard exists yet to paginate or cache.

## Validation

- Prisma schema validation and TypeScript noEmit pass.
- All migration SQL applies to isolated in-memory PGlite, including existing migrations.
- Migration verifier checks ELO defaults, unique phone, an invalid federation reference,
  duplicate audit idempotency, audit UPDATE/DELETE rejection, audit retention on player deletion,
  and successful booking deletion while its rating event remains intact.
- Player linking tests cover cross-club normalization, repeated linking, name preservation,
  invalid phone, phone change conflict, concurrent update and club isolation.
- Existing web suite: 510 files, 4618 tests passed before the final login extraction;
  component suite rerun after extraction.
- Existing phone/bracket/tournament API checks pass; new linking checks pass.

Commands from API directory: `npm run test:federation:migration`, `npm run build`,
`npm test -- src/lib/players.test.ts src/lib/phone.test.ts src/routes/admin/tournaments.test.ts`.
The migration verifier uses no .env, network connection or production database.
