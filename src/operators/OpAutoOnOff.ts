import { IoState }		from '../io-state';
import { IoOperator }	from '../io-operator';
import { IoTimer }		from '../io-timer';
import type { AnyState }	from '../io-state';


/*
 * Automatically switches a boolean state OFF after `autoOffMs` (when ON), or ON after
 * `autoOnMs` (when OFF). Both timers are optional and independent.
 *
 * On `init()`, any elapsed timeout that fired while the adapter was offline is applied
 * immediately so the state is consistent at startup.
 */
export class OpAutoOnOff extends IoOperator {
	private State:			IoState<boolean>;
	private timer:			IoTimer | null	= null;
	private autoOnMs:		number;
	private autoOffMs:		number;

	constructor(State: IoState<boolean>, options: { autoOnMs?: number, autoOffMs?: number }) {
		super([ State ], [], []);
		if (!State.writable	)  { throw new Error(`${this.constructor.name}: constructor(): ${State.stateId}: must be writable` ); }

		this.State = State;
		this.autoOnMs	= options.autoOnMs	?? 0;
		this.autoOffMs	= options.autoOffMs	?? 0;
	}

	/*
	 * Applies any auto-switch that elapsed while the adapter was offline.
	 * If the state has been in its current value longer than the configured timeout,
	 * the switch is fired immediately rather than waiting for an input event.
	 */
	protected override async setup(): Promise<boolean> {
		// switch OFF?
		if (this.State.val  &&  this.autoOffMs > 0) {				// is ON and autoOff enabled?
			if (IoTimer.now() > this.State.ts + this.autoOffMs) {
				await this.State.write(false);								// switch OFF cmd/ack
			}

		// switch ON?
		} else if (!this.State.val  &&  this.autoOnMs > 0) {		// is OFF and autoOn enabled?
			if (IoTimer.now() > this.State.ts + this.autoOnMs) {
				await this.State.write(true);								// switch ON  cmd/ack
			}
		}

		return true;
	}

	/* Cancels any pending timer and schedules a new auto-switch based on `state_.val`. */
	protected override execute(state_: AnyState): void {				// state: input state to switch on/off after timeout
		// clear pending timer
		this.timer = IoTimer.clearTimer(this.timer);

		// switch OFF?
		if (state_.val === true  &&  this.autoOffMs > 0) {				// is ON and autoOff enabled?
			this.timer = IoTimer.setTimer({ name: this.constructor.name, timeoutMs: this.autoOffMs, cb: async () => {
				this.timer = null;
				await state_.write(false);								// switch OFF cmd/ack
			}});

		// switch ON?
		} else if (state_.val === false  &&  this.autoOnMs > 0) {		// is OFF and autoOn enabled?
			this.timer = IoTimer.setTimer({ name: this.constructor.name, timeoutMs: this.autoOnMs, cb: async () => {
				this.timer = null;
				await state_.write(true);								// switch ON  cmd/ack
			}});
		}
	}
}
