import { IoAdapter }		from '../io-adapter';
import { IoOperator }	from '../io-operator';
import type { ValType }	from '../io-adapter';
import type { AnyState }	from '../io-state';


type IfThenElseOp	=	'='   |  '<'  |  '>';
type IfThenElseCond	=	'AND' | 'OR';

/*
 * Configuration for a single IF/AND/OR/THEN/ELSE rule.
 *
 * Evaluation order: IF is tested first; each CONDS entry is applied left-to-right
 * with its own `cond` (AND/OR); the combined result selects THEN or ELSE.
 * ELSE is optional — if absent and the condition is false, no write is performed.
 */
export interface IfThenElseOpts {
	IF:			{ 'ioState': AnyState,							'op': IfThenElseOp,	'value': ValType },
	THEN:		{ 'ioState': AnyState,												'value': ValType },
	ELSE?:		{ 'ioState': AnyState,												'value': ValType }	| undefined,
	CONDS:		{ 'ioState': AnyState,	cond: IfThenElseCond,	'op': IfThenElseOp,	'value': ValType }[],
}

/*
 * Evaluates a compound boolean condition (IF + optional AND/OR chain) and writes
 * a value to THEN or ELSE accordingly on every input-state change.
 *
 * All IF/CONDS states are registered as inputs (trigger execution); THEN and ELSE
 * states are registered as outputs (written by the operator).
 */
export class OpIfThenElse extends IoOperator {
	private IF:		IfThenElseOpts['IF'   ];
	private THEN:	IfThenElseOpts['THEN' ];
	private ELSE:	IfThenElseOpts['ELSE' ];
	private CONDS:	IfThenElseOpts['CONDS'];

	constructor(opts: IfThenElseOpts) {
		const inputs:	AnyState[]	= [ opts.IF  .ioState ].concat(opts.CONDS.map(({ ioState }) => ioState));
		const outputs:	AnyState[]	= [ opts.THEN.ioState ].concat(opts.ELSE ? [ opts.ELSE.ioState ] : []);
		super(inputs, outputs, []);

		this.IF		= opts.IF;
		this.THEN	= opts.THEN;
		this.ELSE	= opts.ELSE;
		this.CONDS	= opts.CONDS;
		IoAdapter.this.logf.debug('%-15s %-15s %-10s %-50s\n%s', this.constructor.name, 'constructor()', '', 'opts:', JSON.stringify(opts, null, 4));
	}

	/* Evaluates the IF/AND/OR condition chain and writes THEN or ELSE accordingly. */
	protected override async execute(_trigger: AnyState): Promise<void> {
		let result = this.evaluate(this.IF);
		for (const COND of this.CONDS) {
			if (COND.cond === 'AND')	{ result &&= this.evaluate(COND); }
			else						{ result ||= this.evaluate(COND); }
		}

		if		(result		)	{ await this.THEN.ioState.write(this.THEN.value);	}
		else if (this.ELSE	)	{ await this.ELSE.ioState.write(this.ELSE.value);	}
	}

	/** Returns true if `ioState.val {op} value` holds (`=` strict equality, `<` less-than, `>` greater-than). */
	private evaluate({ ioState, op, value }: { ioState: AnyState, op: IfThenElseOp, value: ValType }): boolean {
		if		(op === '=')	{ return (ioState.val === value); }		// =
		else if (op === '<')	{ return (ioState.val <   value); }		// <
		else					{ return (ioState.val >   value); }		// >
	}
}
