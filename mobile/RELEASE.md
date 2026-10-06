# iPhone release and test guide

## Required service configuration

1. Deploy the web viewer over HTTPS and place its fixed `/m` route in `EXPO_PUBLIC_VIEWER_URL`. The iOS shell accepts only that origin; never use a LAN address for a release build.
2. Configure Clerk with Apple and Google sign-in enabled, an iOS application using the `doodleforge` URL scheme, and the Convex JWT template named `convex`. Enable self-service user deletion (`deleteSelfEnabled`) for the production Clerk user configuration; the app checks this before queuing data deletion. Set `CLERK_JWT_ISSUER_DOMAIN` in the Convex deployment. Add the provider's Apple and Google credentials in Clerk.
3. Set `EXPO_PUBLIC_CONVEX_URL`, `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`, and `EXPO_PUBLIC_PRIVACY_URL`. Configure the matching production Convex deployment with the World Labs, fal, and Tripo provider keys and OpenRouter if sketch orientation is enabled.
4. Set `EXPO_PUBLIC_PRIVACY_URL` and `EXPO_PUBLIC_SUPPORT_URL` to live HTTPS pages; the app does not proceed to login until these, the viewer, and service configuration are present.
5. Confirm `com.doodleforge.app` is available to the Apple Developer team or replace it with the team's registered bundle identifier. Keep separate Clerk/Convex environments for preview and production.

Before enabling generation, set `WORLD_LABS_MAX_DRAFT_USD`, `WORLD_LABS_MAX_STANDARD_USD`, `WORLD_LABS_MAX_PLUS_USD`, `TRIPO_MAX_JOB_USD`, and `SKETCH_MAX_JOB_USD` on Convex. Use conservative maximum end-to-end charges for your actual API account and provider model settings. Missing or invalid values reject new generations. World Labs API credit pricing is account-specific; Tripo documents credit charges and its base conversion, while fal model prices vary by endpoint. Recheck these values whenever you change models or provider billing.

## Test before public release

- Preview the shell with `cd mobile && npm ci && npx expo start --dev-client`. Clerk native authentication, camera, and the native share sheet require an iOS development build; Expo Go is only useful for layout and non-auth shell checks. The generated iOS project currently requires iOS 17.0, as raised during Expo prebuild; use an iOS 17+ test device.
- With Apple Developer Program access, build/install a signed development client using `eas build --platform ios --profile development`, then test Apple/Google login, permission denial and recovery, camera capture, photo/video selection, generation, background/resume, network interruption, and GLB/STL sharing to Files.
- Build the release candidate with `eas build --platform ios --profile production`, submit it to App Store Connect with `eas submit --platform ios --profile production`, add internal testers in TestFlight, and complete the entire acceptance flow on physical iPhones before manual public release.

## App Store Connect work still required

Complete the privacy policy and support pages, app description, screenshots, final icon, age rating, App Privacy answers for media/prompts and AI processors, export-compliance answers, reviewer sign-in and reproducible generation instructions, and a generation budget/reservation sufficient for review. Confirm data deletion completes in the deployed backend and that late provider jobs cannot restore deleted records. Review iOS permission strings, entitlements, privacy manifests, and required-reason API declarations in the generated archive. Public release is intentionally manual.

The current mobile `npm audit --omit=dev` reports 25 transitive vulnerabilities in Expo/Metro build and signing tools (`braces`, `node-forge`, and `uuid`). `npm audit fix` cannot clear them without a breaking Expo/React Native downgrade, and the toolchain currently reports no compatible fix for part of the set. Review upstream Expo fixes and the advisories again before creating the store archive; do not force the downgrade suggested by npm.

## Preview behavior

The app displays an explicit configuration screen until the Clerk key and Convex URL are provided. It never asks a reviewer to enter a computer's network address. A viewer is loaded only from the configured HTTPS origin, and the native bridge sends short-lived Convex tokens in memory on request.
