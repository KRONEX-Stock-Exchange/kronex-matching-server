import { Order } from '@prisma/client';

export function orderSerializer(orders: Order[]) {
    return orders.map((order) => {
        return {
            ...order,
            number: Number(order.number),
            matchNumber: Number(order.matchNumber),
            price: Number(order.price),
        };
    });
}
