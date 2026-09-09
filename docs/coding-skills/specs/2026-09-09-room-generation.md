# Room generation

The user requested real photo/video uploads and a world-model pipeline with useful quality and short waits. They selected fast preview by default with higher detail on request.

The routing/upload fix already exists in fe3e609. Preserve the capture entry at `/`, explicit existing-world selection, ZIP imports, and resumable world URLs.

Use Marble 1.0 Draft for fast previews and Marble 1.1 for optional detail. One user submission creates one provider operation; never automatically submit another paid generation. Keep original video input so room context is preserved. Show realistic input-dependent timing guidance, with no guaranteed completion time.

Replace in-action sleep polling with scheduled status checks. Store the operation ID, generation deadline, and readable stage. Bound HTTP requests and total waiting; preserve provider errors and allow resuming the same operation after a timeout. Cache 500k splats and colliders concurrently; optional panorama caching must not delay room readiness or fail a usable room. Validate uploads on the server before submitting work.

Verify with Convex integration tests using mocked provider HTTP responses, entry-component rendering checks, existing tests, typecheck/build, and a local browser check. Live provider timing and output quality require configured backend credentials and a real capture.
