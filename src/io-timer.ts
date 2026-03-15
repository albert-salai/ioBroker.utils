import { IoAdapter }		from './io-adapter';


export type SetTimer	= (opts:  TimerOpts)	=> Timer | null;
export type ClearTimer	= (timer: Timer | null)	=> null;
export type TimerNow	= ()					=> number;

type TimerCb = () => void | Promise<void>;

export type TimerOpts = {
	name:			string,
	cb:				TimerCb,
	timeoutMs?:		number,
	intervalMs?:	number,
} & ({ timeoutMs: number } | { intervalMs: number });


// Timer — caller owns scheduling; use clearTimer() to cancel before destroy
export class Timer {
	// Injectable by tests; replace via configure() before first use
	public static setTimer:			SetTimer			= setTimer;
	public static clearTimer:		ClearTimer			= clearTimer;
	public static now:				TimerNow			= now;

	public static configure(timerConfig = { setTimer, clearTimer, now }) {
		Timer.setTimer		= timerConfig.setTimer;
		Timer.clearTimer	= timerConfig.clearTimer;
		Timer.now			= timerConfig.now;
	}

	public readonly	name:	string;
	public readonly	cb:		TimerCb;
	public expireTs:		number;
	public timeoutMs:		number | null;
	public intervalMs:		number | null;
	public timeoutId:		ioBroker.Timeout	= null;
	public intervalId:		ioBroker.Interval	= null;

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
				intervalMs = 0x7FFFFFF;
			}
		}

		this.timeoutMs	= timeoutMs  ?? null;
		this.intervalMs	= intervalMs ?? null;

		if		(this.timeoutMs  !== null)		{ this.expireTs = Timer.now() + this.timeoutMs;		}
		else if (this.intervalMs !== null)		{ this.expireTs = Timer.now() + this.intervalMs;	}
		else									{ this.expireTs = 0;								}
	}
}




function now(): number {
	return Date.now();
}


// When both timeoutMs and intervalMs are set, the timeout fires first; the interval
// starts only after the timeout callback resolves. cb() may call clearTimer() on
// the same timer — nulling the id before starting the interval guards against that.
function setTimer(opts: TimerOpts): Timer {
	const adapter	= IoAdapter.this;
	const timer		= new Timer(opts);

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


function clearTimer(timer: Timer | null): null {
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
