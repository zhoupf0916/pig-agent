# Cloud run details

`#/runs/:id` reads the cloud run directly. Historical and scheduled executions do not need a conversation record to display their result, approvals, artifacts, or journal. All requests use the current authenticated cloud identity and server-side project permissions. Viewers cannot approve or cancel.

The panel reconciles run state, pending approvals, and artifacts every 1.8 seconds while active; durable SSE event IDs deduplicate incremental events. Final text comes from the last authoritative assistant message, including the final `done` session snapshot. The initial journal API returns its latest 200 events; the open panel retains up to 1,000 recent events. It is a recent execution view, not a complete audit export. A mid-execution page load can show only the recent text until the final full reply arrives.

Artifact preview is limited to UTF-8 text up to 512,000 bytes. Known binary formats and larger files remain downloadable. Preview byte limits are enforced while reading, not solely through potentially missing HTTP metadata.

Validation: web TypeScript check passed. Browser acceptance for schedule execution, approvals, and historical runs is performed by the integrated cloud-workspace acceptance flow; do not infer visual acceptance from this static check alone.
