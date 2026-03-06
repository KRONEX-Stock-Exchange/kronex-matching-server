import { Test, TestingModule } from '@nestjs/testing';
import { Order, OrderStatus, OrderType, PrismaClient, TradingType, UserStock } from '@prisma/client';
import { HandleMatchService } from './handle-match.service';
import { OrderUtilService } from './order-util.service';

// ─────────────────────────────────────────────
// 헬퍼 팩토리
// ─────────────────────────────────────────────
const makeOrder = (overrides: Partial<Order> = {}): Order => ({
    id: 1,
    accountId: 1,
    stockId: 1,
    price: 1000n,
    number: 10n,
    matchNumber: 0n,
    orderType: OrderType.limit,
    tradingType: TradingType.buy,
    status: OrderStatus.n,
    createdAt: new Date(),
    ...overrides,
});

const makeUserStock = (overrides: Partial<UserStock> = {}): UserStock => ({
    accountId: 1,
    stockId: 1,
    number: 100n,
    canNumber: 90n,
    average: 1000n,
    totalBuyAmount: 100000n,
    ...overrides,
});

// ─────────────────────────────────────────────
// 테스트
// ─────────────────────────────────────────────
describe('HandleMatchService', () => {
    let service: HandleMatchService;
    let mockOrderUtilService: jest.Mocked<Partial<OrderUtilService>>;
    let mockTx: PrismaClient;

    beforeEach(async () => {
        const defaultReturn: [{ update: number[] }, Map<number, UserStock>] = [
            { update: [] },
            new Map(),
        ];

        mockOrderUtilService = {
            userStockIncrease: jest.fn().mockResolvedValue(defaultReturn),
            userStockDecrease: jest.fn().mockResolvedValue(defaultReturn),
            orderCompleteUpdate: jest.fn().mockResolvedValue(undefined),
            orderMatchAndRemainderUpdate: jest.fn().mockResolvedValue(undefined),
        };

        mockTx = {} as PrismaClient;

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                HandleMatchService,
                { provide: OrderUtilService, useValue: mockOrderUtilService },
            ],
        }).compile();

        service = module.get<HandleMatchService>(HandleMatchService);
    });

    // ─── handleEqualMatch ───────────────────────────────────────────────────────
    describe('handleEqualMatch (submit === find)', () => {
        it('매수(buy) - 매수자 주식 증가, 매도자 주식 감소', async () => {
            const submitOrder = makeOrder({ id: 1, accountId: 10, price: 1000n, tradingType: TradingType.buy });
            const findOrder = makeOrder({ id: 2, accountId: 20, price: 900n, tradingType: TradingType.sell });
            const userStockList = { update: [] };
            const userStocks = new Map<number, UserStock>();

            await service.handleEqualMatch(
                mockTx, submitOrder, findOrder, TradingType.buy, 10n, 10n, userStockList, userStocks,
            );

            // 매수자(submitOrder) 주식 증가
            expect(mockOrderUtilService.userStockIncrease).toHaveBeenCalledWith(
                mockTx, 1, 10, 10n, expect.any(Object), expect.any(Map), findOrder.price,
            );
            // 매도자(findOrder) 주식 감소
            expect(mockOrderUtilService.userStockDecrease).toHaveBeenCalledWith(
                mockTx, 1, 20, 10n, expect.any(Object), expect.any(Map), findOrder.price,
            );
        });

        it('매도(sell) - 매도자 주식 감소, 매수자 주식 증가', async () => {
            const submitOrder = makeOrder({ id: 1, accountId: 10, tradingType: TradingType.sell });
            const findOrder = makeOrder({ id: 2, accountId: 20, tradingType: TradingType.buy });
            const userStockList = { update: [] };
            const userStocks = new Map<number, UserStock>();

            await service.handleEqualMatch(
                mockTx, submitOrder, findOrder, TradingType.sell, 10n, 10n, userStockList, userStocks,
            );

            // 매도자(submitOrder) 주식 감소 먼저
            expect(mockOrderUtilService.userStockDecrease).toHaveBeenCalledWith(
                mockTx, 1, 10, 10n, expect.any(Object), expect.any(Map), findOrder.price,
            );
            // 매수자(findOrder) 주식 증가
            expect(mockOrderUtilService.userStockIncrease).toHaveBeenCalledWith(
                mockTx, 1, 20, 10n, expect.any(Object), expect.any(Map), findOrder.price,
            );
        });

        it('executedAmount = submitOrderNumber * findOrder.price 를 반환한다', async () => {
            const submitOrder = makeOrder({ id: 1, accountId: 10 });
            const findOrder = makeOrder({ id: 2, accountId: 20, price: 900n });

            const [, , executedAmount] = await service.handleEqualMatch(
                mockTx, submitOrder, findOrder, TradingType.buy, 10n, 10n, { update: [] }, new Map(),
            );

            expect(executedAmount).toBe(9000n); // 10 * 900
        });

        it('orderCompleteUpdate를 직접 호출하지 않는다 (processSubmitOrder 책임)', async () => {
            const submitOrder = makeOrder({ id: 1, accountId: 1 });
            const findOrder = makeOrder({ id: 2, accountId: 2 });

            await service.handleEqualMatch(
                mockTx, submitOrder, findOrder, TradingType.buy, 10n, 10n, { update: [] }, new Map(),
            );

            expect(mockOrderUtilService.orderCompleteUpdate).not.toHaveBeenCalled();
        });
    });

    // ─── handleRemainingMatch ───────────────────────────────────────────────────
    describe('handleRemainingMatch (submit < find)', () => {
        it('매수(buy) - submitOrderNumber 기준으로 증가/감소 처리', async () => {
            const submitOrder = makeOrder({ id: 1, accountId: 10, tradingType: TradingType.buy });
            const findOrder = makeOrder({ id: 2, accountId: 20, price: 900n, number: 20n });
            const submitNumber = 5n; // submitRemaining

            await service.handleRemainingMatch(
                mockTx, submitOrder, findOrder, TradingType.buy, submitNumber, { update: [] }, new Map(),
            );

            expect(mockOrderUtilService.userStockIncrease).toHaveBeenCalledWith(
                mockTx, 1, 10, submitNumber, expect.any(Object), expect.any(Map), findOrder.price,
            );
            expect(mockOrderUtilService.userStockDecrease).toHaveBeenCalledWith(
                mockTx, 1, 20, submitNumber, expect.any(Object), expect.any(Map), findOrder.price,
            );
        });

        it('매도(sell) - submitOrderNumber 기준으로 감소/증가 처리', async () => {
            const submitOrder = makeOrder({ id: 1, accountId: 10, tradingType: TradingType.sell });
            const findOrder = makeOrder({ id: 2, accountId: 20, price: 1100n, number: 20n });
            const submitNumber = 3n;

            await service.handleRemainingMatch(
                mockTx, submitOrder, findOrder, TradingType.sell, submitNumber, { update: [] }, new Map(),
            );

            expect(mockOrderUtilService.userStockDecrease).toHaveBeenCalledWith(
                mockTx, 1, 10, submitNumber, expect.any(Object), expect.any(Map), findOrder.price,
            );
            expect(mockOrderUtilService.userStockIncrease).toHaveBeenCalledWith(
                mockTx, 1, 20, submitNumber, expect.any(Object), expect.any(Map), findOrder.price,
            );
        });

        it('executedAmount = submitOrderNumber * findOrder.price 를 반환한다', async () => {
            const submitOrder = makeOrder({ id: 1, accountId: 10 });
            const findOrder = makeOrder({ id: 2, accountId: 20, price: 1200n });

            const [, , executedAmount] = await service.handleRemainingMatch(
                mockTx, submitOrder, findOrder, TradingType.buy, 7n, { update: [] }, new Map(),
            );

            expect(executedAmount).toBe(8400n); // 7 * 1200
        });

        it('orderCompleteUpdate를 직접 호출하지 않는다 (processSubmitOrder 책임)', async () => {
            const submitOrder = makeOrder({ id: 1, accountId: 1 });
            const findOrder = makeOrder({ id: 2, accountId: 2 });

            await service.handleRemainingMatch(
                mockTx, submitOrder, findOrder, TradingType.buy, 5n, { update: [] }, new Map(),
            );

            expect(mockOrderUtilService.orderCompleteUpdate).not.toHaveBeenCalled();
        });
    });

    // ─── handlePartialMatch ─────────────────────────────────────────────────────
    describe('handlePartialMatch (submit > find)', () => {
        it('매수(buy) - findOrderNumber 기준으로 증가/감소 처리', async () => {
            const submitOrder = makeOrder({ id: 1, accountId: 10, number: 20n, tradingType: TradingType.buy });
            const findOrder = makeOrder({ id: 2, accountId: 20, price: 900n, number: 8n });
            const findNumber = 8n; // findRemaining

            await service.handlePartialMatch(
                mockTx, submitOrder, findOrder, TradingType.buy, findNumber, { update: [] }, new Map(),
            );

            expect(mockOrderUtilService.userStockIncrease).toHaveBeenCalledWith(
                mockTx, 1, 10, findNumber, expect.any(Object), expect.any(Map), findOrder.price,
            );
            expect(mockOrderUtilService.userStockDecrease).toHaveBeenCalledWith(
                mockTx, 1, 20, findNumber, expect.any(Object), expect.any(Map), findOrder.price,
            );
        });

        it('매도(sell) - findOrderNumber 기준으로 감소/증가 처리', async () => {
            const submitOrder = makeOrder({ id: 1, accountId: 10, number: 20n, tradingType: TradingType.sell });
            const findOrder = makeOrder({ id: 2, accountId: 20, price: 1000n, number: 6n });
            const findNumber = 6n;

            await service.handlePartialMatch(
                mockTx, submitOrder, findOrder, TradingType.sell, findNumber, { update: [] }, new Map(),
            );

            expect(mockOrderUtilService.userStockDecrease).toHaveBeenCalledWith(
                mockTx, 1, 10, findNumber, expect.any(Object), expect.any(Map), findOrder.price,
            );
            expect(mockOrderUtilService.userStockIncrease).toHaveBeenCalledWith(
                mockTx, 1, 20, findNumber, expect.any(Object), expect.any(Map), findOrder.price,
            );
        });

        it('findOrder 완전 체결 - orderCompleteUpdate를 findOrder로 호출한다', async () => {
            const submitOrder = makeOrder({ id: 1, accountId: 10, number: 20n });
            const findOrder = makeOrder({ id: 2, accountId: 20, number: 8n });

            await service.handlePartialMatch(
                mockTx, submitOrder, findOrder, TradingType.buy, 8n, { update: [] }, new Map(),
            );

            expect(mockOrderUtilService.orderCompleteUpdate).toHaveBeenCalledWith(
                mockTx,
                [findOrder],
                findOrder.number,
            );
        });

        it('submitOrder 잔여 업데이트 - orderMatchAndRemainderUpdate를 submitOrder로 호출한다', async () => {
            const submitOrder = makeOrder({ id: 1, accountId: 10, number: 20n });
            const findOrder = makeOrder({ id: 2, accountId: 20, number: 8n });

            await service.handlePartialMatch(
                mockTx, submitOrder, findOrder, TradingType.buy, 8n, { update: [] }, new Map(),
            );

            expect(mockOrderUtilService.orderMatchAndRemainderUpdate).toHaveBeenCalledWith(
                mockTx,
                submitOrder,
                findOrder,
            );
        });

        it('executedAmount = findOrderNumber * findOrder.price 를 반환한다', async () => {
            const submitOrder = makeOrder({ id: 1, accountId: 10, number: 20n });
            const findOrder = makeOrder({ id: 2, accountId: 20, price: 850n, number: 6n });

            const [, , executedAmount] = await service.handlePartialMatch(
                mockTx, submitOrder, findOrder, TradingType.buy, 6n, { update: [] }, new Map(),
            );

            expect(executedAmount).toBe(5100n); // 6 * 850
        });

        it('userStockList와 userStocks를 체인으로 전달하여 반환한다', async () => {
            const submitOrder = makeOrder({ id: 1, accountId: 10, number: 20n });
            const findOrder = makeOrder({ id: 2, accountId: 20, number: 8n });

            const inputList = { update: [99] };
            const inputMap = new Map<number, UserStock>([[99, makeUserStock({ accountId: 99 })]]);

            const afterIncrease: [{ update: number[] }, Map<number, UserStock>] = [{ update: [99, 10] }, new Map(inputMap)];
            const afterDecrease: [{ update: number[] }, Map<number, UserStock>] = [{ update: [99, 10, 20] }, new Map(inputMap)];

            (mockOrderUtilService.userStockIncrease as jest.Mock).mockResolvedValueOnce(afterIncrease);
            (mockOrderUtilService.userStockDecrease as jest.Mock).mockResolvedValueOnce(afterDecrease);

            const [resultList] = await service.handlePartialMatch(
                mockTx, submitOrder, findOrder, TradingType.buy, 8n, inputList, inputMap,
            );

            expect(resultList.update).toContain(20);
        });
    });
});
