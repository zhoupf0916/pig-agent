# 2026-09-22 redesign baseline

Captured from the existing built application, isolated workbench http://127.0.0.1:8799 with data/redesign-local/store; mock cluster http://127.0.0.1:8892. No user 8797/8890 service or real model key used.

54 viewport screenshots: 1440×900, 1280×800, 390×844, requested light and dark appearance. States: empty, settings, long-content, executing, approval, result, error, recovery, admin-runners. Screenshots use viewport capture, not full-page images, so first-screen clipping is visible.

UI task list and long Markdown are explicitly tagged [UI夹具]. At least 15 long Chinese titles are present. Approval, result, download and recovery are real mock-container interactions. Downloaded cloud-proof.txt exactly equals PIG_CLOUD_CONTAINER_OK. Error/recovery uses browser network interruption against remote endpoints. The executing matrix may reach pending approval while sweeping sizes, because the real mock model is fast; it is not a deterministic synthetic running state. The previous admin has no dark-mode implementation, so its dark-requested screenshots correctly show the old unsupported state.

manifest.json records dimensions, routes, fixture IDs, real session ID, browser errors and DOM measurements. Root review screenshots were inspected alongside these images.

Observed baseline:
- Empty task header 122px at both desktop widths; 226.8px on 390px mobile, before the mobile task row.
- Empty task permanently reserves a 300px artifact panel with two empty sections.
- Mobile approval opens a global near-screen modal, retaining redundant run/task lists. Approve/reject are below the initial viewport.
- Settings mixes developer diagnostics, execution selection, remote connection and model fields in one tall scroll surface.

The script capture-before.mjs targets old UI selectors and must only be rerun against the old baseline build. New screenshots must be captured from the new source using an after-specific interaction script, with the same dimensions and filenames for comparison.

Secondary page files named page-projects/page-experts/page-automations/page-memory/page-search were added later, after the new global shell was in place but before those page bodies were redesigned. They document the old secondary-page layout inside the new shell, not a full original-release capture. The original 54-state matrix remains the pre-redesign baseline.
