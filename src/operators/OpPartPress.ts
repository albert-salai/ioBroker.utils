import { IoAdapter, dateStr, valStr }	from '../io-adapter';
import { IoState }						from '../io-state';
import { IoOperator }					from '../io-operator';
import { Magnus }						from '../io-util';
import type { AnyState }	from '../io-state';

const magnus = new Magnus();


/*
 * Computes the partial pressure of water vapour from relative humidity and temperature
 * using the Magnus formula (`magnus.dd(temp, relhum)`) and writes the result in hPa.
 *
 * Relhum triggers execution; Temp is a read-only dependency.
 * On init, executes once immediately to seed the output.
 */
export class OpPartPress extends IoOperator {
	private Relhum:			IoState<number>;		// input
	private Temp:			IoState<number>;		// other
	private Partpres:		IoState<number>;		// output

	constructor({ Relhum, Temp, Partpres }: {
		Relhum:			IoState<number>,
		Temp:			IoState<number>,
		Partpres:		IoState<number>
	}) {
		super([ Relhum ], [ Partpres ], [ Temp ]);

		this.Relhum 	= Relhum;
		this.Temp		= Temp;
		this.Partpres	= Partpres;
	}

	/* Runs `super.setup()` then executes once to seed Partpres from current sensor values. */
	protected override async setup(): Promise<boolean> {
		await super.setup();
		await this.execute(this.Relhum);
		return true;
	}

	/* Recomputes and writes partial pressure; logs a warning for non-finite inputs or results. */
	protected override async execute(_trigger: AnyState): Promise<void> {
		const relhum	= this.Relhum.val
		const temp		= this.Temp.val;

		if (! Number.isFinite(temp)) {
			IoAdapter.logf.warn('%-15s %-25s %-45s %s',		this.constructor.name, 'execute()', this.Temp.stateId,		'invalid input temp '  +JSON.stringify(this.Temp.val  ));

		} else if (! Number.isFinite(relhum)) {
			IoAdapter.logf.warn('%-15s %-25s %-45s %s',		this.constructor.name, 'execute()', this.Relhum.stateId,	'invalid input relhum '+JSON.stringify(this.Relhum.val));

		} else {
			const pp = magnus.dd(temp, relhum);
			// 50 hPa is the saturation vapour pressure at ~33 °C — physically unreachable indoors;
			// values above this indicate a bad sensor reading and must not be logged to history.
			if (! Number.isFinite(pp)  ||  pp > 50) {
				IoAdapter.logf.warn('%-15s %-25s %-45s %s',		this.constructor.name, 'execute()', this.Partpres.stateId, 'invalid partpres ' + JSON.stringify(pp));
				IoAdapter.logf.warn('%-15s %-25s %-45s %s  %s',	this.constructor.name, 'execute()', this.Relhum.stateId,	dateStr(this.Relhum.ts), valStr(this.Relhum.val));
				IoAdapter.logf.warn('%-15s %-25s %-45s %s  %s',	this.constructor.name, 'execute()', this.Temp.stateId,		dateStr(this.Temp  .ts), valStr(this.Temp  .val));

			} else {
				await this.Partpres.write(pp);
			}
		}
	}
}
