import { Test, TestingModule } from '@nestjs/testing';
import { Order, OrderStatus, OrderType, PrismaClient, TradingType, UserStock } from '@prisma/client';
import { OrderExecutionService } from './order-execution.service';
import { HandleMatchService } from './services/handle-match.service';
import { OrderUtilService } from './services/order-util.service';

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

const makeMockTx = () =>
    ({
        $queryRaw: jest.fn(),
        order: {
            findFirst: jest.fn(),
            update: jest.fn().mockResolvedValue({}),
        },
        orderMatch: {
            createMany: jest.fn().mockResolvedValue({}),
        },
        userStock: {
            update: jest.fn().mockResolvedValue({}),
        },
        account: {
            update: jest.fn().mockResolvedValue({}),
        },
        stock: {
            findUnique: jest.fn().mockResolvedValue({ price: 1000n }),
            update: jest.fn().mockResolvedValue({}),
        },
        stockHistory: {
            upsert: jest.fn().mockResolvedValue({ low: 1000n, high: 1000n }),
            update: jest.fn().mockResolvedValue({}),
        },
    }) as unknown as PrismaClient;

// matchReturn: [userStockList, userStocks, executedAmount]
const matchReturn = (executedAmount = 0n): [{ update: number[] }, Map<number, UserStock>, bigint] =>
    [{ update: [] }, new Map(), executedAmount];

// handlePartialMatch 모킹 시 userStocks Map 상태 보존용
const partialMatchImpl = (executedAmount: bigint) =>
    async (_tx: unknown, _s: unknown, _f: unknown, _type: unknown, _num: unknown, list: { update: number[] }, stocks: Map<number, UserStock>) =>
        [list, stocks, executedAmount] as const;

// ─────────────────────────────────────────────
// 테스트
// ─────────────────────────────────────────────
describe('OrderExecutionService', () => {
    let service: OrderExecutionService;
    let mockHandleMatchService: jest.Mocked<HandleMatchService>;
    let mockOrderUtilService: Partial<OrderUtilService>;

    beforeEach(async () => {
        mockHandleMatchService = {
            handleEqualMatch: jest.fn().mockResolvedValue(matchReturn()),
            handleRemainingMatch: jest.fn().mockResolvedValue(matchReturn()),
            handlePartialMatch: jest.fn().mockResolvedValue(matchReturn()),
        } as any;

        mockOrderUtilService = {
            getRemaining: (order: Order) => order.number - (order.matchNumber ?? 0n),
            stockPriceUpdate: jest.fn().mockResolvedValue(undefined),
            orderCompleteUpdate: jest.fn().mockResolvedValue(undefined),
            orderMatchAndRemainderUpdate: jest.fn().mockResolvedValue(undefined),
            createOrderMatch: jest.fn().mockReturnValue({
                stockId: 1, number: 10n, initialOrderId: 2, orderId: 1, matchedAt: new Date(),
            }),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                OrderExecutionService,
                { provide: HandleMatchService, useValue: mockHandleMatchService },
                { provide: OrderUtilService, useValue: mockOrderUtilService },
            ],
        }).compile();

        service = module.get<OrderExecutionService>(OrderExecutionService);
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // 지정가 매수 주문
    // ═══════════════════════════════════════════════════════════════════════════
    describe('지정가 매수 주문', () => {
        it('미체결 - 체결 가능한 매도 주문이 없으면 주문이 대기 상태로 남는다', async () => {
            const tx = makeMockTx();
            const submitOrder = makeOrder({
                id: 1, accountId: 1, number: 10n, matchNumber: 0n,
                tradingType: TradingType.buy, orderType: OrderType.limit, price: 1000n,
            });

            (tx.$queryRaw as jest.Mock).mockResolvedValue([makeUserStock({ accountId: 1 })]);
            (tx.order.findFirst as jest.Mock).mockResolvedValue(null);
            (tx.stock.findUnique as jest.Mock).mockResolvedValue({ price: 1000n });

            const result = await service.processSubmitOrder(tx, submitOrder, 10000n);

            expect(result).toEqual([{ id: 1, accountId: 1 }]);
            expect(mockHandleMatchService.handleEqualMatch).not.toHaveBeenCalled();
            expect(mockHandleMatchService.handleRemainingMatch).not.toHaveBeenCalled();
            expect(mockHandleMatchService.handlePartialMatch).not.toHaveBeenCalled();
            // 체결 없으므로 match 로그도 없음
            expect(tx.orderMatch.createMany).toHaveBeenCalledWith({ data: [] });
        });

        it('전량체결 - 동일 수량의 매도 주문과 완전 체결된다', async () => {
            const tx = makeMockTx();
            // 매수 10주 @ 1000원
            const submitOrder = makeOrder({
                id: 1, accountId: 1, number: 10n, matchNumber: 0n,
                tradingType: TradingType.buy, orderType: OrderType.limit, price: 1000n,
            });
            // 매도 10주 @ 900원 (매수가 이하 → 체결 가능)
            const sellOrder = makeOrder({
                id: 2, accountId: 2, number: 10n, matchNumber: 0n,
                tradingType: TradingType.sell, price: 900n,
            });

            (tx.$queryRaw as jest.Mock)
                .mockResolvedValueOnce([makeUserStock({ accountId: 1 })])
                .mockResolvedValueOnce([makeUserStock({ accountId: 2 })]);
            (tx.order.findFirst as jest.Mock).mockResolvedValueOnce(sellOrder);
            (mockHandleMatchService.handleEqualMatch as jest.Mock).mockResolvedValue(matchReturn(9000n));

            const result = await service.processSubmitOrder(tx, submitOrder, 10000n);

            expect(mockHandleMatchService.handleEqualMatch).toHaveBeenCalledTimes(1);
            expect(mockHandleMatchService.handleEqualMatch).toHaveBeenCalledWith(
                tx, submitOrder, sellOrder, TradingType.buy, 10n, 10n, expect.any(Object), expect.any(Map),
            );
            expect(mockOrderUtilService.orderCompleteUpdate).toHaveBeenCalledWith(tx, [sellOrder, submitOrder]);
            expect(result).toContainEqual({ id: 1, accountId: 1 });
            expect(result).toContainEqual({ id: 2, accountId: 2 });
        });

        it('전량체결 - 주문가(1000원)보다 낮은 가격(800원)에 체결되면 차액이 예수금으로 환불된다', async () => {
            const tx = makeMockTx();
            const submitOrder = makeOrder({
                id: 1, accountId: 1, number: 10n, matchNumber: 0n,
                tradingType: TradingType.buy, orderType: OrderType.limit, price: 1000n,
            });
            const sellOrder = makeOrder({
                id: 2, accountId: 2, number: 10n, matchNumber: 0n,
                tradingType: TradingType.sell, price: 800n,
            });

            (tx.$queryRaw as jest.Mock).mockResolvedValue([makeUserStock({ accountId: 1 })]);
            (tx.order.findFirst as jest.Mock).mockResolvedValueOnce(sellOrder);

            const lockedBalance = 10000n; // 10주 * 1000원
            const executedAmount = 8000n; // 10주 * 800원
            (mockHandleMatchService.handleEqualMatch as jest.Mock).mockImplementation(async () => {
                submitOrder.matchNumber = submitOrder.number; // 완전체결
                return matchReturn(executedAmount);
            });

            await service.processSubmitOrder(tx, submitOrder, lockedBalance);

            // 차액 환불: 10000 - 8000 = 2000원
            expect(tx.account.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 1 },
                    data: { canMoney: { increment: 2000n } },
                }),
            );
        });

        it('전량체결 - 주문가와 동일한 가격(1000원)에 체결되면 환불이 없다', async () => {
            const tx = makeMockTx();
            const submitOrder = makeOrder({
                id: 1, accountId: 1, number: 10n, matchNumber: 0n,
                tradingType: TradingType.buy, orderType: OrderType.limit, price: 1000n,
            });
            const sellOrder = makeOrder({
                id: 2, accountId: 2, number: 10n, matchNumber: 0n,
                tradingType: TradingType.sell, price: 1000n,
            });

            (tx.$queryRaw as jest.Mock).mockResolvedValue([makeUserStock({ accountId: 1 })]);
            (tx.order.findFirst as jest.Mock).mockResolvedValueOnce(sellOrder);
            (mockHandleMatchService.handleEqualMatch as jest.Mock).mockImplementation(async () => {
                submitOrder.matchNumber = submitOrder.number;
                return matchReturn(10000n); // lockedBalance와 동일
            });

            await service.processSubmitOrder(tx, submitOrder, 10000n);

            // 차액 없으므로 account.update 미호출
            expect(tx.account.update).not.toHaveBeenCalled();
        });

        it('전량체결 - 여러 매도 주문을 순차적으로 체결한다 (10주 × 3건)', async () => {
            const tx = makeMockTx();
            // 매수 30주
            const submitOrder = makeOrder({
                id: 1, accountId: 1, number: 30n, matchNumber: 0n,
                tradingType: TradingType.buy, orderType: OrderType.limit, price: 1000n,
            });
            // 매도 3건 (각 10주)
            const sellOrder1 = makeOrder({ id: 2, accountId: 2, number: 10n, matchNumber: 0n, tradingType: TradingType.sell, price: 900n });
            const sellOrder2 = makeOrder({ id: 3, accountId: 3, number: 10n, matchNumber: 0n, tradingType: TradingType.sell, price: 920n });
            const sellOrder3 = makeOrder({ id: 4, accountId: 4, number: 10n, matchNumber: 0n, tradingType: TradingType.sell, price: 950n });

            (tx.$queryRaw as jest.Mock).mockResolvedValue([makeUserStock({ accountId: 1 })]);
            (tx.order.findFirst as jest.Mock)
                .mockResolvedValueOnce(sellOrder1)
                .mockResolvedValueOnce(sellOrder2)
                .mockResolvedValueOnce(sellOrder3);
            (mockHandleMatchService.handlePartialMatch as jest.Mock).mockResolvedValue(matchReturn(9000n));
            (mockHandleMatchService.handleEqualMatch as jest.Mock).mockResolvedValue(matchReturn(9500n));

            await service.processSubmitOrder(tx, submitOrder, 30000n);

            // sellOrder1, sellOrder2 → 부분체결(partial), sellOrder3 → 완전체결(equal)
            expect(mockHandleMatchService.handlePartialMatch).toHaveBeenCalledTimes(2);
            expect(mockHandleMatchService.handleEqualMatch).toHaveBeenCalledTimes(1);
            expect(mockHandleMatchService.handleEqualMatch).toHaveBeenCalledWith(
                tx, submitOrder, sellOrder3, TradingType.buy, 10n, 10n, expect.any(Object), expect.any(Map),
            );
        });

        it('부분체결 - 내 수량(20주)이 매도 주문(10주)보다 많으면 매도 주문이 소진되고 잔량(10주)이 대기한다', async () => {
            const tx = makeMockTx();
            const submitOrder = makeOrder({
                id: 1, accountId: 1, number: 20n, matchNumber: 0n,
                tradingType: TradingType.buy, orderType: OrderType.limit, price: 1000n,
            });
            const sellOrder = makeOrder({
                id: 2, accountId: 2, number: 10n, matchNumber: 0n,
                tradingType: TradingType.sell, price: 900n,
            });

            (tx.$queryRaw as jest.Mock)
                .mockResolvedValueOnce([makeUserStock({ accountId: 1 })])
                .mockResolvedValueOnce([makeUserStock({ accountId: 2 })]);
            (tx.order.findFirst as jest.Mock)
                .mockResolvedValueOnce(sellOrder)
                .mockResolvedValueOnce(null); // 추가 매도 주문 없음
            (tx.stock.findUnique as jest.Mock).mockResolvedValue({ price: 900n });
            (mockHandleMatchService.handlePartialMatch as jest.Mock).mockResolvedValue(matchReturn(9000n));

            await service.processSubmitOrder(tx, submitOrder, 20000n);

            expect(mockHandleMatchService.handlePartialMatch).toHaveBeenCalledTimes(1);
            expect(mockHandleMatchService.handlePartialMatch).toHaveBeenCalledWith(
                tx, submitOrder, sellOrder, TradingType.buy, 10n, expect.any(Object), expect.any(Map),
            );
            // 잔량 10주가 대기 → 주문 취소나 체결 없음
            expect(tx.order.update).not.toHaveBeenCalledWith(
                expect.objectContaining({ data: { status: OrderStatus.c } }),
            );
        });

        it('부분체결 - 내 수량(5주)이 매도 주문(10주)보다 적으면 내 주문이 완전체결되고 매도 주문에 잔량(5주)이 남는다', async () => {
            const tx = makeMockTx();
            const submitOrder = makeOrder({
                id: 1, accountId: 1, number: 5n, matchNumber: 0n,
                tradingType: TradingType.buy, orderType: OrderType.limit, price: 1000n,
            });
            const sellOrder = makeOrder({
                id: 2, accountId: 2, number: 10n, matchNumber: 0n,
                tradingType: TradingType.sell, price: 900n,
            });

            (tx.$queryRaw as jest.Mock)
                .mockResolvedValueOnce([makeUserStock({ accountId: 1 })])
                .mockResolvedValueOnce([makeUserStock({ accountId: 2 })]);
            (tx.order.findFirst as jest.Mock).mockResolvedValueOnce(sellOrder);
            (mockHandleMatchService.handleRemainingMatch as jest.Mock).mockResolvedValue(matchReturn(4500n));

            await service.processSubmitOrder(tx, submitOrder, 5000n);

            expect(mockHandleMatchService.handleRemainingMatch).toHaveBeenCalledWith(
                tx, submitOrder, sellOrder, TradingType.buy, 5n, expect.any(Object), expect.any(Map),
            );
            // 내 주문 완전체결
            expect(mockOrderUtilService.orderCompleteUpdate).toHaveBeenCalledWith(tx, [submitOrder], submitOrder.number);
            // 매도 주문에 잔여 수량 반영
            expect(mockOrderUtilService.orderMatchAndRemainderUpdate).toHaveBeenCalledWith(tx, sellOrder, submitOrder);
        });

        it('부분체결 - 미체결 수량에 해당하는 잠금 예수금이 해제된다', async () => {
            const tx = makeMockTx();
            // 매수 20주 @ 1000원 → 10주만 체결, 나머지 10주 대기
            const submitOrder = makeOrder({
                id: 1, accountId: 1, number: 20n, matchNumber: 0n,
                tradingType: TradingType.buy, orderType: OrderType.limit, price: 1000n,
            });
            const sellOrder = makeOrder({
                id: 2, accountId: 2, number: 10n, matchNumber: 0n,
                tradingType: TradingType.sell, price: 950n,
            });

            (tx.$queryRaw as jest.Mock).mockResolvedValue([makeUserStock({ accountId: 1 })]);
            (tx.order.findFirst as jest.Mock)
                .mockResolvedValueOnce(sellOrder)
                .mockResolvedValueOnce(null);
            (tx.stock.findUnique as jest.Mock).mockResolvedValue({ price: 950n });
            (mockHandleMatchService.handlePartialMatch as jest.Mock).mockResolvedValue(matchReturn(9500n));

            const lockedBalance = 20000n; // 20주 * 1000원
            await service.processSubmitOrder(tx, submitOrder, lockedBalance);

            // 잠금 해제 = lockedBalance - (실체결금액 + 주문가 * 잔여수량)
            // = 20000 - (9500 + 1000 * 10) = 500원
            expect(tx.account.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 1 },
                    data: { canMoney: { increment: 500n } },
                }),
            );
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // 지정가 매도 주문
    // ═══════════════════════════════════════════════════════════════════════════
    describe('지정가 매도 주문', () => {
        it('미체결 - 체결 가능한 매수 주문이 없으면 주문이 대기 상태로 남는다', async () => {
            const tx = makeMockTx();
            const submitOrder = makeOrder({
                id: 1, accountId: 1, number: 10n, matchNumber: 0n,
                tradingType: TradingType.sell, orderType: OrderType.limit, price: 1000n,
            });

            (tx.$queryRaw as jest.Mock).mockResolvedValue([makeUserStock({ accountId: 1 })]);
            (tx.order.findFirst as jest.Mock).mockResolvedValue(null);
            (tx.stock.findUnique as jest.Mock).mockResolvedValue({ price: 1000n });

            const result = await service.processSubmitOrder(tx, submitOrder);

            expect(result).toEqual([{ id: 1, accountId: 1 }]);
            expect(mockHandleMatchService.handleEqualMatch).not.toHaveBeenCalled();
        });

        it('전량체결 - 동일 수량의 매수 주문과 완전 체결된다', async () => {
            const tx = makeMockTx();
            // 매도 5주 @ 1000원
            const submitOrder = makeOrder({
                id: 1, accountId: 1, number: 5n, matchNumber: 0n,
                tradingType: TradingType.sell, orderType: OrderType.limit, price: 1000n,
            });
            // 매수 5주 @ 1100원 (매도가 이상 → 체결 가능)
            const buyOrder = makeOrder({
                id: 2, accountId: 2, number: 5n, matchNumber: 0n,
                tradingType: TradingType.buy, price: 1100n,
            });

            (tx.$queryRaw as jest.Mock)
                .mockResolvedValueOnce([makeUserStock({ accountId: 1 })])
                .mockResolvedValueOnce([makeUserStock({ accountId: 2 })]);
            (tx.order.findFirst as jest.Mock).mockResolvedValueOnce(buyOrder);
            (mockHandleMatchService.handleEqualMatch as jest.Mock).mockResolvedValue(matchReturn(5500n));

            await service.processSubmitOrder(tx, submitOrder);

            expect(mockHandleMatchService.handleEqualMatch).toHaveBeenCalledWith(
                tx, submitOrder, buyOrder, TradingType.sell, 5n, 5n, expect.any(Object), expect.any(Map),
            );
        });

        it('부분체결 - 내 수량(15주)이 매수 주문(5주)보다 많으면 매수 주문이 소진되고 잔량(10주)이 대기한다', async () => {
            const tx = makeMockTx();
            const submitOrder = makeOrder({
                id: 1, accountId: 1, number: 15n, matchNumber: 0n,
                tradingType: TradingType.sell, orderType: OrderType.limit, price: 900n,
            });
            const buyOrder = makeOrder({
                id: 2, accountId: 2, number: 5n, matchNumber: 0n,
                tradingType: TradingType.buy, price: 1000n,
            });

            (tx.$queryRaw as jest.Mock)
                .mockResolvedValueOnce([makeUserStock({ accountId: 1 })])
                .mockResolvedValueOnce([makeUserStock({ accountId: 2 })]);
            (tx.order.findFirst as jest.Mock)
                .mockResolvedValueOnce(buyOrder)
                .mockResolvedValueOnce(null);
            (tx.stock.findUnique as jest.Mock).mockResolvedValue({ price: 1000n });
            (mockHandleMatchService.handlePartialMatch as jest.Mock).mockResolvedValue(matchReturn(5000n));

            await service.processSubmitOrder(tx, submitOrder);

            expect(mockHandleMatchService.handlePartialMatch).toHaveBeenCalledWith(
                tx, submitOrder, buyOrder, TradingType.sell, 5n, expect.any(Object), expect.any(Map),
            );
        });

        it('부분체결 - 내 수량(3주)이 매수 주문(10주)보다 적으면 내 주문이 완전체결되고 매수 주문에 잔량(7주)이 남는다', async () => {
            const tx = makeMockTx();
            const submitOrder = makeOrder({
                id: 1, accountId: 1, number: 3n, matchNumber: 0n,
                tradingType: TradingType.sell, orderType: OrderType.limit, price: 900n,
            });
            const buyOrder = makeOrder({
                id: 2, accountId: 2, number: 10n, matchNumber: 0n,
                tradingType: TradingType.buy, price: 1000n,
            });

            (tx.$queryRaw as jest.Mock)
                .mockResolvedValueOnce([makeUserStock({ accountId: 1 })])
                .mockResolvedValueOnce([makeUserStock({ accountId: 2 })]);
            (tx.order.findFirst as jest.Mock).mockResolvedValueOnce(buyOrder);
            (mockHandleMatchService.handleRemainingMatch as jest.Mock).mockResolvedValue(matchReturn(3000n));

            await service.processSubmitOrder(tx, submitOrder);

            expect(mockHandleMatchService.handleRemainingMatch).toHaveBeenCalledWith(
                tx, submitOrder, buyOrder, TradingType.sell, 3n, expect.any(Object), expect.any(Map),
            );
            expect(mockOrderUtilService.orderCompleteUpdate).toHaveBeenCalledWith(tx, [submitOrder], submitOrder.number);
            expect(mockOrderUtilService.orderMatchAndRemainderUpdate).toHaveBeenCalledWith(tx, buyOrder, submitOrder);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // 시장가 매수 주문
    // ═══════════════════════════════════════════════════════════════════════════
    describe('시장가 매수 주문', () => {
        it('전량체결 - 매도 호가와 즉시 완전 체결된다', async () => {
            const tx = makeMockTx();
            const submitOrder = makeOrder({
                id: 1, accountId: 1, number: 10n, matchNumber: 0n,
                tradingType: TradingType.buy, orderType: OrderType.market, price: 0n,
            });
            const sellOrder = makeOrder({
                id: 2, accountId: 2, number: 10n, matchNumber: 0n,
                tradingType: TradingType.sell, price: 900n,
            });

            (tx.$queryRaw as jest.Mock)
                .mockResolvedValueOnce([makeUserStock({ accountId: 1 })])
                .mockResolvedValueOnce([makeUserStock({ accountId: 2 })]);
            (tx.order.findFirst as jest.Mock).mockResolvedValueOnce(sellOrder);
            (mockHandleMatchService.handleEqualMatch as jest.Mock).mockImplementation(async () => {
                submitOrder.matchNumber = submitOrder.number;
                return matchReturn(9000n);
            });

            await service.processSubmitOrder(tx, submitOrder, 10000n);

            expect(mockHandleMatchService.handleEqualMatch).toHaveBeenCalledTimes(1);
            // 전량체결 → 주문 취소 없음
            expect(tx.order.update).not.toHaveBeenCalledWith(
                expect.objectContaining({ data: { status: OrderStatus.c } }),
            );
        });

        it('부분체결 - 매도 호가 소진 후 미체결 수량은 주문이 취소되고 잔여 예수금이 환불된다', async () => {
            const tx = makeMockTx();
            // 매수 20주, 시장가
            const submitOrder = makeOrder({
                id: 1, accountId: 1, number: 20n, matchNumber: 0n,
                tradingType: TradingType.buy, orderType: OrderType.market, price: 0n,
            });
            // 매도 10주만 있음
            const sellOrder = makeOrder({
                id: 2, accountId: 2, number: 10n, matchNumber: 0n,
                tradingType: TradingType.sell, price: 900n,
            });

            (tx.$queryRaw as jest.Mock)
                .mockResolvedValueOnce([makeUserStock({ accountId: 1 })])
                .mockResolvedValueOnce([makeUserStock({ accountId: 2 })]);
            (tx.order.findFirst as jest.Mock)
                .mockResolvedValueOnce(sellOrder)
                .mockResolvedValueOnce(null); // 추가 매도 없음
            (mockHandleMatchService.handlePartialMatch as jest.Mock).mockResolvedValue(matchReturn(9000n));

            const lockedBalance = 20000n;
            await service.processSubmitOrder(tx, submitOrder, lockedBalance);

            // 미체결 주문 취소
            expect(tx.order.update).toHaveBeenCalledWith(
                expect.objectContaining({ where: { id: 1 }, data: { status: OrderStatus.c } }),
            );
            // 잔여 예수금 환불: 20000 - 9000 = 11000원
            expect(tx.account.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 1 },
                    data: { canMoney: { increment: 11000n } },
                }),
            );
        });

        it('미체결 - 체결 가능한 매도 주문이 없으면 주문 전체가 취소되고 예수금 전액이 환불된다', async () => {
            const tx = makeMockTx();
            const submitOrder = makeOrder({
                id: 1, accountId: 1, number: 10n, matchNumber: 0n,
                tradingType: TradingType.buy, orderType: OrderType.market, price: 0n,
            });

            (tx.$queryRaw as jest.Mock).mockResolvedValue([makeUserStock({ accountId: 1 })]);
            (tx.order.findFirst as jest.Mock).mockResolvedValue(null);

            const lockedBalance = 15000n;
            await service.processSubmitOrder(tx, submitOrder, lockedBalance);

            // 주문 취소
            expect(tx.order.update).toHaveBeenCalledWith(
                expect.objectContaining({ where: { id: 1 }, data: { status: OrderStatus.c } }),
            );
            // 예수금 전액 환불
            expect(tx.account.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 1 },
                    data: { canMoney: { increment: 15000n } },
                }),
            );
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // 시장가 매도 주문
    // ═══════════════════════════════════════════════════════════════════════════
    describe('시장가 매도 주문', () => {
        it('전량체결 - 매수 호가와 즉시 완전 체결된다', async () => {
            const tx = makeMockTx();
            const submitOrder = makeOrder({
                id: 1, accountId: 1, number: 5n, matchNumber: 0n,
                tradingType: TradingType.sell, orderType: OrderType.market, price: 0n,
            });
            const buyOrder = makeOrder({
                id: 2, accountId: 2, number: 5n, matchNumber: 0n,
                tradingType: TradingType.buy, price: 1000n,
            });

            (tx.$queryRaw as jest.Mock)
                .mockResolvedValueOnce([makeUserStock({ accountId: 1 })])
                .mockResolvedValueOnce([makeUserStock({ accountId: 2 })]);
            (tx.order.findFirst as jest.Mock).mockResolvedValueOnce(buyOrder);
            (mockHandleMatchService.handleEqualMatch as jest.Mock).mockImplementation(async () => {
                submitOrder.matchNumber = submitOrder.number;
                return matchReturn(5000n);
            });

            await service.processSubmitOrder(tx, submitOrder);

            expect(mockHandleMatchService.handleEqualMatch).toHaveBeenCalledTimes(1);
            expect(tx.order.update).not.toHaveBeenCalledWith(
                expect.objectContaining({ data: { status: OrderStatus.c } }),
            );
        });

        it('부분체결 - 매수 호가 소진 후 미체결 수량은 주문이 취소되고 잔여 주식 수량이 환불된다', async () => {
            const tx = makeMockTx();
            // 매도 20주, 시장가
            const submitOrder = makeOrder({
                id: 1, accountId: 1, number: 20n, matchNumber: 0n,
                tradingType: TradingType.sell, orderType: OrderType.market, price: 0n,
            });
            // 매수 5주만 있음
            const buyOrder = makeOrder({
                id: 2, accountId: 2, number: 5n, matchNumber: 0n,
                tradingType: TradingType.buy, price: 1000n,
            });

            (tx.$queryRaw as jest.Mock)
                .mockResolvedValueOnce([makeUserStock({ accountId: 1 })])
                .mockResolvedValueOnce([makeUserStock({ accountId: 2 })]);
            (tx.order.findFirst as jest.Mock)
                .mockResolvedValueOnce(buyOrder)
                .mockResolvedValueOnce(null);
            (mockHandleMatchService.handlePartialMatch as jest.Mock).mockResolvedValue(matchReturn(5000n));

            await service.processSubmitOrder(tx, submitOrder);

            // 미체결 주문 취소
            expect(tx.order.update).toHaveBeenCalledWith(
                expect.objectContaining({ where: { id: 1 }, data: { status: OrderStatus.c } }),
            );
            // 미체결 수량 환불: 20 - 5 = 15주
            expect(tx.userStock.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { accountId_stockId: { accountId: 1, stockId: 1 } },
                    data: { canNumber: { increment: 15n } },
                }),
            );
        });

        it('미체결 - 체결 가능한 매수 주문이 없으면 주문 전체가 취소되고 주식 수량 전량이 환불된다', async () => {
            const tx = makeMockTx();
            const submitOrder = makeOrder({
                id: 1, accountId: 1, number: 8n, matchNumber: 0n,
                tradingType: TradingType.sell, orderType: OrderType.market, price: 0n,
            });

            (tx.$queryRaw as jest.Mock).mockResolvedValue([makeUserStock({ accountId: 1 })]);
            (tx.order.findFirst as jest.Mock).mockResolvedValue(null);

            await service.processSubmitOrder(tx, submitOrder);

            // 주문 취소
            expect(tx.order.update).toHaveBeenCalledWith(
                expect.objectContaining({ where: { id: 1 }, data: { status: OrderStatus.c } }),
            );
            // 주식 수량 전량 환불: 8주
            expect(tx.userStock.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: { canNumber: { increment: 8n } },
                }),
            );
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // 호가 조회 (findOrder)
    // ═══════════════════════════════════════════════════════════════════════════
    describe('호가 조회 (findOrder)', () => {
        it('지정가 매수 - 주문가(1000원) 이하의 매도 주문을 낮은 가격 · 오래된 순으로 조회한다', async () => {
            const tx = makeMockTx();
            const submitOrder = makeOrder({ price: 1000n, orderType: OrderType.limit, tradingType: TradingType.buy });
            (tx.order.findFirst as jest.Mock).mockResolvedValue(null);

            await service.findOrder(tx, submitOrder, TradingType.buy);

            expect(tx.order.findFirst).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        tradingType: TradingType.sell,
                        status: OrderStatus.n,
                        price: { lte: 1000n },
                    }),
                    orderBy: [{ price: 'asc' }, { createdAt: 'asc' }],
                    take: 1,
                }),
            );
        });

        it('지정가 매도 - 주문가(900원) 이상의 매수 주문을 높은 가격 · 오래된 순으로 조회한다', async () => {
            const tx = makeMockTx();
            const submitOrder = makeOrder({ price: 900n, orderType: OrderType.limit, tradingType: TradingType.sell });
            (tx.order.findFirst as jest.Mock).mockResolvedValue(null);

            await service.findOrder(tx, submitOrder, TradingType.sell);

            expect(tx.order.findFirst).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        tradingType: TradingType.buy,
                        status: OrderStatus.n,
                        price: { gte: 900n },
                    }),
                    orderBy: [{ price: 'desc' }, { createdAt: 'asc' }],
                }),
            );
        });

        it('시장가 매수 - 가격 조건 없이 모든 매도 주문을 조회한다', async () => {
            const tx = makeMockTx();
            const submitOrder = makeOrder({ price: 0n, orderType: OrderType.market, tradingType: TradingType.buy });
            (tx.order.findFirst as jest.Mock).mockResolvedValue(null);

            await service.findOrder(tx, submitOrder, TradingType.buy);

            const call = (tx.order.findFirst as jest.Mock).mock.calls[0][0];
            expect(call.where.price).toEqual({});
        });

        it('시장가 매도 - 가격 조건 없이 모든 매수 주문을 조회한다', async () => {
            const tx = makeMockTx();
            const submitOrder = makeOrder({ price: 0n, orderType: OrderType.market, tradingType: TradingType.sell });
            (tx.order.findFirst as jest.Mock).mockResolvedValue(null);

            await service.findOrder(tx, submitOrder, TradingType.sell);

            const call = (tx.order.findFirst as jest.Mock).mock.calls[0][0];
            expect(call.where.price).toEqual({});
        });

        it('같은 종목(stockId)의 주문만 조회한다', async () => {
            const tx = makeMockTx();
            const submitOrder = makeOrder({ stockId: 42 });
            (tx.order.findFirst as jest.Mock).mockResolvedValue(null);

            await service.findOrder(tx, submitOrder, TradingType.buy);

            const call = (tx.order.findFirst as jest.Mock).mock.calls[0][0];
            expect(call.where.stockId).toBe(42);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // 체결 공통 처리
    // ═══════════════════════════════════════════════════════════════════════════
    describe('체결 공통 처리', () => {
        it('체결 시 체결가로 주식 현재가가 업데이트된다', async () => {
            const tx = makeMockTx();
            const submitOrder = makeOrder({ id: 1, accountId: 1, number: 10n, matchNumber: 0n });
            const sellOrder = makeOrder({ id: 2, accountId: 2, number: 10n, matchNumber: 0n, price: 850n, tradingType: TradingType.sell });

            (tx.$queryRaw as jest.Mock).mockResolvedValue([makeUserStock()]);
            (tx.order.findFirst as jest.Mock).mockResolvedValueOnce(sellOrder);
            (mockHandleMatchService.handleEqualMatch as jest.Mock).mockResolvedValue(matchReturn(8500n));

            await service.processSubmitOrder(tx, submitOrder, 10000n);

            expect(mockOrderUtilService.stockPriceUpdate).toHaveBeenCalledWith(tx, 1, 850n);
        });

        it('체결 시 양쪽 주문이 모두 updatedOrders에 포함된다', async () => {
            const tx = makeMockTx();
            const submitOrder = makeOrder({ id: 1, accountId: 1, number: 10n, matchNumber: 0n });
            const sellOrder = makeOrder({ id: 2, accountId: 2, number: 10n, matchNumber: 0n, tradingType: TradingType.sell });

            (tx.$queryRaw as jest.Mock).mockResolvedValue([makeUserStock()]);
            (tx.order.findFirst as jest.Mock).mockResolvedValueOnce(sellOrder).mockResolvedValueOnce(null);
            (mockHandleMatchService.handleEqualMatch as jest.Mock).mockResolvedValue(matchReturn(10000n));

            const result = await service.processSubmitOrder(tx, submitOrder, 10000n);

            expect(result).toContainEqual({ id: 1, accountId: 1 });
            expect(result).toContainEqual({ id: 2, accountId: 2 });
        });

        it('미체결 시 제출한 주문만 updatedOrders에 포함된다', async () => {
            const tx = makeMockTx();
            const submitOrder = makeOrder({ id: 1, accountId: 1 });

            (tx.$queryRaw as jest.Mock).mockResolvedValue([makeUserStock()]);
            (tx.order.findFirst as jest.Mock).mockResolvedValue(null);
            (tx.stock.findUnique as jest.Mock).mockResolvedValue({ price: 1000n });

            const result = await service.processSubmitOrder(tx, submitOrder, 10000n);

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({ id: 1, accountId: 1 });
        });

        it('여러 건 체결 시 모든 주문이 updatedOrders에 포함된다', async () => {
            const tx = makeMockTx();
            const submitOrder = makeOrder({ id: 1, accountId: 1, number: 20n, matchNumber: 0n });
            const sellOrder1 = makeOrder({ id: 2, accountId: 2, number: 10n, matchNumber: 0n, tradingType: TradingType.sell });
            const sellOrder2 = makeOrder({ id: 3, accountId: 3, number: 10n, matchNumber: 0n, tradingType: TradingType.sell });

            (tx.$queryRaw as jest.Mock).mockResolvedValue([makeUserStock()]);
            (tx.order.findFirst as jest.Mock)
                .mockResolvedValueOnce(sellOrder1)
                .mockResolvedValueOnce(sellOrder2);
            (mockHandleMatchService.handlePartialMatch as jest.Mock).mockResolvedValue(matchReturn(10000n));
            (mockHandleMatchService.handleEqualMatch as jest.Mock).mockResolvedValue(matchReturn(10000n));

            const result = await service.processSubmitOrder(tx, submitOrder, 20000n);

            expect(result).toContainEqual({ id: 1, accountId: 1 });
            expect(result).toContainEqual({ id: 2, accountId: 2 });
            expect(result).toContainEqual({ id: 3, accountId: 3 });
        });

        it('체결 건별로 orderMatch 로그가 기록된다', async () => {
            const tx = makeMockTx();
            const submitOrder = makeOrder({ id: 1, accountId: 1, number: 10n, matchNumber: 0n });
            const sellOrder = makeOrder({ id: 2, accountId: 2, number: 10n, matchNumber: 0n, tradingType: TradingType.sell });

            (tx.$queryRaw as jest.Mock).mockResolvedValue([makeUserStock()]);
            (tx.order.findFirst as jest.Mock).mockResolvedValueOnce(sellOrder).mockResolvedValueOnce(null);
            (mockHandleMatchService.handleEqualMatch as jest.Mock).mockResolvedValue(matchReturn(10000n));

            const mockMatchLog = { stockId: 1, number: 10n, orderId: 1, initialOrderId: 2, matchedAt: new Date() };
            (mockOrderUtilService.createOrderMatch as jest.Mock).mockReturnValue(mockMatchLog);

            await service.processSubmitOrder(tx, submitOrder, 10000n);

            expect(tx.orderMatch.createMany).toHaveBeenCalledWith({ data: [mockMatchLog] });
        });

        it('체결된 주식 보유 현황(userStock)이 업데이트된다', async () => {
            const tx = makeMockTx();
            const submitOrder = makeOrder({ id: 1, accountId: 1, number: 10n, matchNumber: 0n });
            const sellOrder = makeOrder({ id: 2, accountId: 2, number: 10n, matchNumber: 0n, tradingType: TradingType.sell });
            const updatedStock = makeUserStock({ accountId: 1, number: 110n, canNumber: 100n });

            (tx.$queryRaw as jest.Mock).mockResolvedValue([makeUserStock({ accountId: 1 })]);
            (tx.order.findFirst as jest.Mock).mockResolvedValueOnce(sellOrder).mockResolvedValueOnce(null);
            (mockHandleMatchService.handleEqualMatch as jest.Mock).mockResolvedValue([{ update: [1] }, new Map([[1, updatedStock]]), 10000n]);

            await service.processSubmitOrder(tx, submitOrder, 10000n);

            expect(tx.userStock.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { accountId_stockId: { accountId: 1, stockId: 1 } },
                    data: expect.objectContaining({ number: 110n }),
                }),
            );
        });

        it('주문 체결 시 user_stocks를 FOR UPDATE 락으로 조회해 동시성 충돌을 방지한다', async () => {
            const tx = makeMockTx();
            const submitOrder = makeOrder({ id: 1, accountId: 5, stockId: 7 });

            (tx.$queryRaw as jest.Mock).mockResolvedValue([makeUserStock({ accountId: 5 })]);
            (tx.order.findFirst as jest.Mock).mockResolvedValue(null);
            (tx.stock.findUnique as jest.Mock).mockResolvedValue({ price: 1000n });

            await service.processSubmitOrder(tx, submitOrder, 10000n);

            const rawQuery = (tx.$queryRaw as jest.Mock).mock.calls[0];
            expect(rawQuery[0].join('')).toContain('FOR UPDATE');
        });

        it('같은 계좌의 상대방 주문이 연속 등장해도 FOR UPDATE 락은 1회만 실행된다', async () => {
            const tx = makeMockTx();
            const submitOrder = makeOrder({ id: 1, accountId: 1, number: 20n, matchNumber: 0n, tradingType: TradingType.buy });
            // 같은 accountId:2의 매도 주문 2건
            const sellOrder1 = makeOrder({ id: 2, accountId: 2, number: 8n, matchNumber: 0n, tradingType: TradingType.sell });
            const sellOrder2 = makeOrder({ id: 3, accountId: 2, number: 12n, matchNumber: 0n, tradingType: TradingType.sell });

            (tx.$queryRaw as jest.Mock)
                .mockResolvedValueOnce([makeUserStock({ accountId: 1 })])
                .mockResolvedValueOnce([makeUserStock({ accountId: 2 })]);
            (tx.order.findFirst as jest.Mock)
                .mockResolvedValueOnce(sellOrder1)
                .mockResolvedValueOnce(sellOrder2);
            (mockHandleMatchService.handlePartialMatch as jest.Mock).mockImplementation(
                partialMatchImpl(8000n),
            );
            (mockHandleMatchService.handleEqualMatch as jest.Mock).mockImplementation(
                async (_tx, _s, _f, _type, _sNum, _fNum, list, stocks) => [list, stocks, 12000n],
            );

            await service.processSubmitOrder(tx, submitOrder, 20000n);

            // submitOrder(1회) + accountId:2 최초 등장(1회) = 총 2회
            expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
        });
    });
});
