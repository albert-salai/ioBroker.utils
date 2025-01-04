import { IoAdapter, dateStr }		from './io-adapter';


// SetTimer, ClearTimer
export type Now			= ()						=> number;
export type SetTimer	= (opts:  TimerOpts)		=> Timer | null;
export type ClearTimer	= (timer: Timer | null)		=> null;

// TimerOpts, SetTimer, ClearTimer
export interface TimerOpts {
	name:			string,
	cb:				TimerCb
	timeout?:		number,
	interval?:		number,
}

// TimerCb
type TimerCb = () => Promise<void>;

// ~~~~~
// Timer
// ~~~~~
export class Timer {
	public static now:			Now			= _now;
	public static setTimer:		SetTimer	= _setTimer;
	public static clearTimer:	ClearTimer	= _clearTimer;
	public name:			string;
	public timeout:			number | null;
	public interval:		number | null;
	public expires:			number;
	public timeoutId:		ioBroker.Timeout		= null;
	public intervalId:		ioBroker.Interval		= null;
	public cb:				TimerCb;

	constructor(opts: TimerOpts) {
		this.name	= opts.name;
		this.cb		= opts.cb;

		// timeout, interval
		if (opts.timeout !== undefined  &&  opts.timeout < 0) {
			IoAdapter.logf.warn('%-15s %-15s %-10s timeout %f < 0; set to 0', this.constructor.name, 'constructor()', '', opts.timeout);
		}
		if (opts.interval !== undefined  &&  opts.interval < 0) {
			IoAdapter.logf.warn('%-15s %-15s %-10s interval %f < 0; set to 0', this.constructor.name, 'constructor()', '', opts.interval);
		}
		this.timeout	= (opts.timeout  === undefined) ? null : Math.max(0, opts.timeout );
		this.interval	= (opts.interval === undefined) ? null : Math.max(0, opts.interval);

		// expires
		if		(this.timeout  !== null)	{ this.expires = Timer.now() + this.timeout;  }
		else if (this.interval !== null)	{ this.expires = Timer.now() + this.interval; }
		else								throw new Error(`${this.constructor.name}: constructor(): `);
	}


	/**
	 *
	 * @param opts
	 */
	public static init(opts?: { getNow: Now, setTimer: SetTimer, clearTimer: ClearTimer }) {
		const { getNow, setTimer, clearTimer } = opts ?? {
			'getNow':		_now,
			'setTimer':		_setTimer,
			'clearTimer':	_clearTimer,
		};
		Timer.now			= getNow;
		Timer.setTimer		= setTimer;
		Timer.clearTimer	= clearTimer;
	}


	/**
	 *
	 * @returns
	 */
	public toString(): string {
		return JSON.stringify({
			'name':			this.name,
			'timeout_s':	(this.timeout    === null) ? null : Math.ceil(this.timeout /100)/10,
			'interval_s':	(this.interval   === null) ? null : Math.ceil(this.interval/100)/10,
			'expires':		dateStr(this.expires),
			'timeoutId':	(this.timeoutId  === null) ? null : this.timeoutId.toString(),
			'intervalId':	(this.intervalId === null) ? null : this.intervalId.toString(),
			'cb':			`<${typeof this.cb}>`,
		}, null, 4);
	}
}



/**
 *
 * @returns
 */
function _now(): number {
	return Date.now();
}


/**
 *
 * @returns
 */
function _setTimer(opts: TimerOpts): Timer {
	const adapter	= IoAdapter.this;
	const timer		= new Timer(opts);

	// start setTimeout()
	if (timer.timeout !== null) {
		//adapter.logf.debug('%-15s %-15s %-10s %-50s %s', this.name, '_setTimer()', 'started 1', timer.name, dateStr(Timer.getNow()));
		timer.timeoutId = adapter.setTimeout(async () => {
			//adapter.logf.debug('%-15s %-15s %-10s %-50s %s', this.name, '_setTimer()', 'elapsed 1', timer.name, dateStr(Timer.getNow()));

			// setTimeout() expired
			await adapter.runExclusive(() => timer.cb());				// may call _clearTimer()
			timer.timeoutId = null;

			// start setInterval()
			if (timer.interval !== null) {
				//adapter.logf.debug('%-15s %-15s %-10s %-50s %s', this.name, '_setTimer()', 'started 2', timer.name, dateStr(Timer.getNow()));
				timer.intervalId = adapter.setInterval(async () => {
					//adapter.logf.debug('%-15s %-15s %-10s %-50s %s', this.name, '_setTimer()', 'elapsed 2', timer.name, dateStr(Timer.getNow()));
					await adapter.runExclusive(() => timer.cb());		// may call _clearTimer()
				}, timer.interval) ?? null;
			}
		}, timer.timeout) ?? null;

	// start setInterval()
	} else if (timer.interval !== null) {
		//adapter.logf.debug('%-15s %-15s %-10s %-50s %s', this.name, '_setTimer()', 'started 3', timer.name, dateStr(Timer.getNow()));
		timer.intervalId = adapter.setInterval(async () => {
			//adapter.logf.debug('%-15s %-15s %-10s %-50s %s', this.name, '_setTimer()', 'elapsed 3', timer.name, dateStr(Timer.getNow()));
			await adapter.runExclusive(() => timer.cb());				// may call _clearTimer()
		}, timer.interval) ?? null;
	}

	return timer;
}


/**
 *
 * @param timer
 * @returns
 */
function _clearTimer(timer: Timer | null): null {
	const adapter = IoAdapter.this;
	if (timer) {
		if (timer.timeoutId !== null) {
			//adapter.logf.debug('%-15s %-15s %-10s %-50s %s', this.name, '_clearTimer()', 'cleared', timer.name, dateStr(Timer.getNow()));
			adapter.clearTimeout(timer.timeoutId);
			timer.timeoutId = null;
		}
		if (timer.intervalId !== null) {
			//adapter.logf.debug('%-15s %-15s %-10s %-50s %s', this.name, '_clearTimer()', 'cleared', timer.name, dateStr(Timer.getNow()));
			adapter.clearInterval(timer.intervalId);
			timer.intervalId = null;
		}
	}
	return null;
}
