// The refund window is shared by server-side eligibility checks and UI copy.
// Keep this module database-free so routes can safely import it in the browser.
export const REFUND_WINDOW_DAYS = 14;
