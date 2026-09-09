# Room generation implementation plan

Goal: fast default creation using real uploaded media and World Labs, with optional higher detail.

Architecture: capture entry passes an explicit model choice into the existing upload mutation. Convex schedules bounded operation checks and concurrent asset caching, exposing progress on the world row.

Tech stack: React, TypeScript, Convex, Vitest, World Labs REST API.

- [x] Add failing integration tests for provider errors, server media validation, scheduled completion, and the fast/default versus detail model.
- [x] Update `convex/worlds.ts` and `convex/schema.ts`: preflight upload/key validation; bounded HTTP; durable operation polling; concurrent required assets; separate optional panorama; resume existing operation.
- [x] Add capture quality selector, timing hints, and viewer progress/resume controls. Keep explicit navigation and ZIP behavior.
- [x] Verify tests, build, and browser entry/upload behavior. Update README and configuration notes with actual verification limits.

No deployment credentials are in this clone. Keep all changes local and report any live verification requirement explicitly.
