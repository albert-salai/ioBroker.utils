import { IoAdapter }		from './io-adapter';


// SetTimer, ClearTimer
export type SetTimer	= (opts:  TimerOpts)	=> Timer | null;
export type ClearTimer	= (timer: Timer | null)	=> null;
export type TimerNow	= ()					=> number;

// TimerCb
type TimerCb = () => void | Promise<void>;

// TimerOpts, SetTimer, ClearTimer
export type TimerOpts = {
	name:			string,
	cb:				TimerCb,
	timeoutMs?:		number,
	intervalMs?:	number,
} & ({ timeoutMs: number } | { intervalMs: number });


// ~~~~~
// Timer
// ~~~~~
export class Timer {
	// configurable Timer functions
	public static setTimer:			SetTimer			= setTimer;			// (opts:  TimerOpts)		=> Timer | null;
	public static clearTimer:		ClearTimer			= clearTimer;		// (timer: Timer | null)	=> null;
	public static now:				TimerNow			= now;				// ()						=> number;

	/**
	 *
	 * @param timerConfig
	 */
	public static configure(timerConfig = { setTimer, clearTimer, now }) {
		Timer.setTimer		= timerConfig.setTimer;
		Timer.clearTimer	= timerConfig.clearTimer;
		Timer.now			= timerConfig.now;
	}

	// Timer properties
	public readonly	name:	string;
	public readonly	cb:		TimerCb;
	public expireTs:		number;
	public timeoutMs:		number | null;
	public intervalMs:		number | null;
	public timeoutId:		ioBroker.Timeout	= null;
	public intervalId:		ioBroker.Interval	= null;

	/**
	 *
	 * @param opts
	 */
	constructor(opts: TimerOpts) {
		let { timeoutMs, intervalMs } = opts;
		this.name	= opts.name;
		this.cb		= opts.cb;

		// check timeout
		if (timeoutMs !== undefined) {
			if (timeoutMs < 0) {
				IoAdapter.logf.error('%-15s %-15s %-10s timer %s: invalid timeout %f < 0', this.constructor.name, 'constructor()', '', opts.name, timeoutMs);
				timeoutMs = undefined;
			} else if (timeoutMs > 0x7FFFFFFF) {
				IoAdapter.logf.error('%-15s %-15s %-10s timer %s: invalid timeout %f > 0x7FFFFFFF', this.constructor.name, 'constructor()', '', opts.name, timeoutMs);
				timeoutMs = 0x7FFFFFFF;
			}
		}

		// check interval
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

		// _expireTs
		if		(this.timeoutMs  !== null)		{ this.expireTs = Timer.now() + this.timeoutMs;		}
		else if (this.intervalMs !== null)		{ this.expireTs = Timer.now() + this.intervalMs;	}
		else									{ this.expireTs = 0;								}
	}
}




/**
 *
 * @returns
 */
function now(): number {
	return Date.now();
}


/**
 *
 * @returns
 */
function setTimer(opts: TimerOpts): Timer {
	const adapter	= IoAdapter.this;
	const timer		= new Timer(opts);

	// start setTimeout()
	if (timer.timeoutMs !== null) {
		timer.timeoutId = adapter.setTimeoutAsync(async () => {
			// setTimeout() expired
			await timer.cb();					// may call clearTimer()
			timer.timeoutId = null;

			// start setInterval()
			if (timer.intervalMs !== null) {
				timer.intervalId = adapter.setIntervalAsync(async () => {
					await timer.cb();			// may call clearTimer()
				}, timer.intervalMs) ?? null;
			}
		}, timer.timeoutMs) ?? null;

	// start setInterval()
	} else if (timer.intervalMs !== null) {
		timer.intervalId = adapter.setIntervalAsync(async () => {
			await timer.cb();					// may call clearTimer()
		}, timer.intervalMs) ?? null;
	}

	return timer;
}


/**
 *
 * @param timer
 * @returns
 */
function clearTimer(timer: Timer | null): null {
	const adapter = IoAdapter.this;

	if (timer) {
		// clearTimeout()
		if (timer.timeoutId !== null) {
			adapter.clearTimeout(timer.timeoutId);
			timer.timeoutId = null;
		}

		// clearInterval()
		if (timer.intervalId !== null) {
			adapter.clearInterval(timer.intervalId);
			timer.intervalId = null;
		}
	}

	return null;
}
