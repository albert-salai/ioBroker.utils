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
};

// TimerCb
type TimerCb = () => Promise<void>;

// ~~~~~
// Timer
// ~~~~~
export class Timer {
	public static now:			Now						= _now;
	public static setTimer:		SetTimer				= _setTimer;
	public static clearTimer:	ClearTimer				= _clearTimer;
	public name:				string;
	public timeoutSecs:			number | null;
	public intervalSecs:		number | null;
	public expireTs:			number;
	public timeoutId:			ioBroker.Timeout		= null;
	public intervalId:			ioBroker.Interval		= null;
	public cb:					TimerCb;

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
		this.timeoutSecs	= (opts.timeout  === undefined) ? null : Math.max(0, opts.timeout );
		this.intervalSecs	= (opts.interval === undefined) ? null : Math.max(0, opts.interval);

		// expires
		if		(this.timeoutSecs  !== null)	{ this.expireTs = Timer.now() + this.timeoutSecs;  }
		else if (this.intervalSecs !== null)	{ this.expireTs = Timer.now() + this.intervalSecs; }
		else									throw new Error(`${this.constructor.name}: constructor(): `);
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
			'name':				this.name,
			'timeoutSecs':		(this.timeoutSecs  === null) ? null : Math.ceil(this.timeoutSecs /100)/10,
			'intervalSecs':		(this.intervalSecs === null) ? null : Math.ceil(this.intervalSecs/100)/10,
			'expireTs':			dateStr(this.expireTs),
			'timeoutId':		(this.timeoutId  === null) ? null : this.timeoutId.toString(),
			'intervalId':		(this.intervalId === null) ? null : this.intervalId.toString(),
			'cb':				`<${typeof this.cb}>`,
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
	if (timer.timeoutSecs !== null) {
		//adapter.logf.debug('%-15s %-15s %-10s %-50s %s', this.name, '_setTimer()', 'started 1', timer.name, dateStr(Timer.getNow()));
		timer.timeoutId = adapter.setTimeoutAsync(async () => {
			//adapter.logf.debug('%-15s %-15s %-10s %-50s %s', this.name, '_setTimer()', 'elapsed 1', timer.name, dateStr(Timer.getNow()));

			// setTimeout() expired
			await timer.cb();					// may call _clearTimer()
			timer.timeoutId = null;

			// start setInterval()
			if (timer.intervalSecs !== null) {
				//adapter.logf.debug('%-15s %-15s %-10s %-50s %s', this.name, '_setTimer()', 'started 2', timer.name, dateStr(Timer.getNow()));
				timer.intervalId = adapter.setIntervalAsync(async () => {
					//adapter.logf.debug('%-15s %-15s %-10s %-50s %s', this.name, '_setTimer()', 'elapsed 2', timer.name, dateStr(Timer.getNow()));
					await timer.cb();			// may call _clearTimer()
				}, timer.intervalSecs) ?? null;
			}
		}, timer.timeoutSecs) ?? null;

	// start setInterval()
	} else if (timer.intervalSecs !== null) {
		//adapter.logf.debug('%-15s %-15s %-10s %-50s %s', this.name, '_setTimer()', 'started 3', timer.name, dateStr(Timer.getNow()));
		timer.intervalId = adapter.setIntervalAsync(async () => {
			//adapter.logf.debug('%-15s %-15s %-10s %-50s %s', this.name, '_setTimer()', 'elapsed 3', timer.name, dateStr(Timer.getNow()));
			await timer.cb();					// may call _clearTimer()
		}, timer.intervalSecs) ?? null;
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
