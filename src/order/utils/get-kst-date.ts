export function getKstDate(daysOffset: number = 0) {
    const now = new Date();
    now.setDate(now.getDate() + daysOffset);

    const kstDateStr = now.toLocaleDateString('sv-SE', {
        timeZone: 'Asia/Seoul',
    });

    return new Date(kstDateStr + 'T00:00:00.000Z');
}
