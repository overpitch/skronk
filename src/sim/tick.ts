/** Fixed simulation rate. Every sim duration is a whole number of ticks. */
export const TICK_RATE = 60;
export const TICK_DT = 1 / TICK_RATE;

export const secondsToTicks = (seconds: number) => Math.round(seconds * TICK_RATE);
