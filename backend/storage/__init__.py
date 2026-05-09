"""On-Pi storage primitives. Stdlib-only (no DB drivers).

Phase 8 (offline queue + reliability) introduces this package. Future
phases may add credential / model-checksum stores under the same
namespace; keep imports explicit at call sites rather than re-exporting
from here.
"""
