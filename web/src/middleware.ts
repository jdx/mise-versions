import { defineMiddleware } from 'astro:middleware';
import { errorResponse } from './lib/api';

const PROTECTED_ROUTES = [
    '/api/admin/',
    '/api/token/',
];

export const onRequest = defineMiddleware(({ request, url, locals }, next) => {
    const runtime = locals.runtime;

    const isProtected = PROTECTED_ROUTES.some(route => url.pathname.startsWith(route));

    if (isProtected) {
        const secret = runtime.env.API_SECRET;
        const authHeader = request.headers.get('authorization');

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return errorResponse('Missing or invalid authorization header', 401);
        }

        const token = authHeader.slice(7);
        if (token !== secret) {
            return errorResponse('Invalid API secret', 401);
        }
    }

    return next();
});
