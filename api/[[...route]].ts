import { handle } from 'hono/vercel';
import { app } from '../relay/index.js';

/**
 * Vercel entry point for the relay: every /api/* request lands here and is
 * served by the same Hono app that `npm run relay:dev` runs locally.
 *
 * The `.js` specifier is what Node resolves after Vercel compiles the
 * TypeScript; the type checker maps it back to relay/index.ts.
 */
export const GET = handle(app);
export const POST = handle(app);
