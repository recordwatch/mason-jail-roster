import { ADMIN_KEY } from './config.js';

// Admin/debug routes can mutate or delete the canonical data files, so they
// require a key even though the rest of the site is public.
export function requireAdminKey(req, res, next) {
  if (!ADMIN_KEY) {
    return res.status(503).json({ error: 'Admin endpoints disabled: ADMIN_KEY not configured' });
  }
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}
