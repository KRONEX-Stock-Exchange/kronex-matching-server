export type BuyOrder = {
    accountNumber: number;
    stockId: number;
    price: bigint;
    number: bigint;
    orderType: 'limit' | 'market';
    lockedBalance: 0n;
};
