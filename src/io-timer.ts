import { IoAdapter }		from './io-adapter';


type SetTimer	= (opts:  TimerOpts)		=> IoTimer | null;
type ClearTimer	= (timer: IoTimer | null)	=> null;
type TimerNow	= ()						=> number;

type TimerCb = () => void | Promise<void>;

/* Options for scheduling a timer; at least one of timeoutMs or intervalMs must be provided. */
export type TimerOpts = {
	name:			string,
	cb:				TimerCb,
	timeoutMs?:		number,
	intervalMs?:	number,
} & ({ timeoutMs: number } | { intervalMs: number });


/* Returns current wall-clock time in epoch-ms. */
function now(): number {
	return Date.now();
}


/*
 * Schedules the timer described by opts. If both timeoutMs and intervalMs are set,
 * the timeout fires first and the interval starts only after the timeout callback resolves.
 * Returns the Timer instance with all scheduling handles populated.
 */
function setTimer(opts: TimerOpts): IoTimer {
	const adapter	= IoAdapter.this;
	const timer		= new IoTimer(opts);

	if (timer.timeoutMs !== null) {
		timer.timeoutId = adapter.setTimeoutAsync(async () => {
			await timer.cb();				// resolves before interval is scheduled
			timer.timeoutId = null;

			if (timer.intervalMs !== null) {
				timer.intervalId = adapter.setIntervalAsync(async () => {
					await timer.cb();		// cb may call clearTimer(); intervalId read after await
				}, timer.intervalMs) ?? null;
			}
		}, timer.timeoutMs) ?? null;

	} else if (timer.intervalMs !== null) {
		timer.intervalId = adapter.setIntervalAsync(async () => {
			await timer.cb();				// cb may call clearTimer(); intervalId read after await
		}, timer.intervalMs) ?? null;
	}

	return timer;
}


/* Cancels any pending timeout and interval on timer; nulls both handles. Returns null. */
function clearTimer(timer: IoTimer | null): null {
	const adapter = IoAdapter.this;

	if (timer) {
		if (timer.timeoutId !== null) {
			adapter.clearTimeout(timer.timeoutId);
			timer.timeoutId = null;
		}

		if (timer.intervalId !== null) {
			adapter.clearInterval(timer.intervalId);
			timer.intervalId = null;
		}
	}

	return null;
}


/* Caller must call clearTimer() before destroy to cancel pending callbacks. */
export class IoTimer {
	public static setTimer:		SetTimer	= setTimer;
	public static clearTimer:	ClearTimer	= clearTimer;
	public static now:			TimerNow	= now;

	/* Replaces the default setTimer/clearTimer/now implementations. Must be called before first IoTimer use. */
	public static configure(cfg: { setTimer: SetTimer; clearTimer: ClearTimer; now: TimerNow } = { setTimer, clearTimer, now }) {
		IoTimer.setTimer	= cfg.setTimer;
		IoTimer.clearTimer	= cfg.clearTimer;
		IoTimer.now			= cfg.now;
	}

	public readonly	name:	string;
	public readonly	cb:		TimerCb;
	public expireTs:		number;							// absolute epoch-ms when the next fire is expected
	public timeoutMs:		number | null;					// one-shot delay; null if not set
	public intervalMs:		number | null;					// recurring period; null if not set
	public timeoutId:		ioBroker.Timeout	= null;		// handle returned by setTimeoutAsync
	public intervalId:		ioBroker.Interval	= null;		// handle returned by setIntervalAsync

	/* Clamps timeoutMs/intervalMs to [0, 0x7FFFFFFF]; sets expireTs based on the active timing mode. */
	constructor(opts: TimerOpts) {
		let { timeoutMs, intervalMs } = opts;
		this.name	= opts.name;
		this.cb		= opts.cb;

		// 0x7FFFFFFF is the max safe ms value for setTimeout in Node/browsers (32-bit signed int)
		if (timeoutMs !== undefined) {
			if (timeoutMs < 0) {
				IoAdapter.logf.error('%-15s %-15s %-10s timer %s: invalid timeout %f < 0', this.constructor.name, 'constructor()', '', opts.name, timeoutMs);
				timeoutMs = undefined;
			} else if (timeoutMs > 0x7FFFFFFF) {
				IoAdapter.logf.error('%-15s %-15s %-10s timer %s: invalid timeout %f > 0x7FFFFFFF', this.constructor.name, 'constructor()', '', opts.name, timeoutMs);
				timeoutMs = 0x7FFFFFFF;
			}
		}

		if (intervalMs !== undefined) {
			if (intervalMs < 0) {
				IoAdapter.logf.warn('%-15s %-15s %-10s timer %s: invalid interval %f < 0', this.constructor.name, 'constructor()', '', opts.name, intervalMs);
				intervalMs = undefined;
			} else if (intervalMs > 0x7FFFFFFF) {
				IoAdapter.logf.warn('%-15s %-15s %-10s timer %s: invalid interval %f > 0x7FFFFFFF', this.constructor.name, 'constructor()', '', opts.name, intervalMs);
				intervalMs = 0x7FFFFFFF;
			}
		}

		this.timeoutMs	= timeoutMs  ?? null;
		this.intervalMs	= intervalMs ?? null;

		if		(this.timeoutMs  !== null)		{ this.expireTs = IoTimer.now() + this.timeoutMs;	}
		else if (this.intervalMs !== null)		{ this.expireTs = IoTimer.now() + this.intervalMs;	}
		else									{ this.expireTs = 0;								}
	}
}
