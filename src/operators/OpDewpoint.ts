import { IoAdapter, dateStr, valStr }	from '../io-adapter';
import { IoState }						from '../io-state';
import { IoOperator }					from '../io-operator';
import { Magnus }						from '../io-util';
import type { AnyState }	from '../io-state';

const magnus = new Magnus();


/*
 * Computes the dew-point temperature from relative humidity and temperature
 * using the Magnus formula (`magnus.td(temp, relhum)`) and writes the result in °C.
 *
 * Relhum triggers execution; Temp is a read-only dependency.
 * On init, executes once immediately to seed the output.
 */
export class OpDewpoint extends IoOperator {
	private Relhum:			IoState<number>;		// input
	private Temp:			IoState<number>;		// other
	private Dewpoint:		IoState<number>;		// output

	constructor({ Relhum, Temp, Dewpoint }: {
		Relhum:			IoState<number>,
		Temp:			IoState<number>,
		Dewpoint:		IoState<number>
	}) {
		super([ Relhum ], [ Dewpoint ], [ Temp ]);

		this.Relhum 	= Relhum;
		this.Temp		= Temp;
		this.Dewpoint	= Dewpoint;
	}

	/* Runs `super.setup()` then executes once to seed Dewpoint from current sensor values. */
	protected override async setup(): Promise<boolean> {
		await super.setup();
		await this.execute(this.Relhum);
		return true;
	}

	/* Recomputes and writes dew-point temperature; logs a warning for non-finite inputs or results. */
	protected override async execute(_trigger: AnyState): Promise<void> {
		const relhum	= this.Relhum.val
		const temp		= this.Temp.val;

		if (! Number.isFinite(temp)) {
			IoAdapter.logf.warn('%-15s %-25s %-45s %s',		this.constructor.name, 'execute()', this.Temp.stateId,		'invalid input temp '  +JSON.stringify(this.Temp.val  ));

		} else if (! Number.isFinite(relhum)) {
			IoAdapter.logf.warn('%-15s %-25s %-45s %s',		this.constructor.name, 'execute()', this.Relhum.stateId,	'invalid input relhum '+JSON.stringify(this.Relhum.val));

		} else {
			const dewpoint = magnus.td(temp, relhum);
			if (! Number.isFinite(dewpoint)) {
				IoAdapter.logf.warn('%-15s %-25s %-45s %s',		this.constructor.name, 'execute()', this.Dewpoint.stateId, 'invalid dewpoint ' + JSON.stringify(dewpoint));
				IoAdapter.logf.warn('%-15s %-25s %-45s %s  %s',	this.constructor.name, 'execute()', this.Relhum.stateId,	dateStr(this.Relhum.ts), valStr(this.Relhum.val));
				IoAdapter.logf.warn('%-15s %-25s %-45s %s  %s',	this.constructor.name, 'execute()', this.Temp.stateId,		dateStr(this.Temp  .ts), valStr(this.Temp  .val));

			} else {
				await this.Dewpoint.write(dewpoint);
			}
		}
	}
}
