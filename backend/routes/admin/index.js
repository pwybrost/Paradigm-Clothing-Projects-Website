// Everything under /api/admin requires a signed-in user with role = 'admin'.
import { Router } from 'express';
import { loadUser, requireAdmin } from '../../lib/session.js';
import financeRouter from './finance.js';
import ordersRouter from './orders.js';
import productsRouter from './products.js';
import storeRouter from './store.js';

const router = Router();

router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});
router.use(loadUser, requireAdmin);

router.use('/products', productsRouter);
router.use('/orders', ordersRouter);
router.use('/', financeRouter);
router.use('/', storeRouter);

export default router;
