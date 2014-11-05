// takes an IR function object and returns a list of Scratch blocks

module.exports.ffi = {};

module.exports.generateFunctionHat = function(functionContext, func) {
	var spec = func.funcName;
	var inputs = [];
	var defaults = [];

	functionContext.params = [];

	for(var i = 0; i < func.paramList.length; ++i) {
		var pName = "param" + i;

		if(func.paramList[i][1])
			pName = func.paramList[i][1];

		inputs.push(pName);
		functionContext.params.push(pName);
		
		defaults.push(defaultForType(func.paramList[i][0]));
		spec += " "+specifierForType(func.paramList[i][0]);
	}


	return ["procDef", spec, inputs, defaults, false];

}

module.exports.compileFunction = function(func) {
	console.log("Compiling "+JSON.stringify(func)+"...");

	var functionContext = {
		locals: {},
		globalLocalDepth: 0,
		scopedLocalDepth: 0,
		params: [],
		gotoInit: false,
		globalToFree: 0,
		scopeToFree: 0,
		scoped: false
	}

	var blockList = [module.exports.generateFunctionHat(functionContext, func)];

	if(func.inGotoComplex) {
		blockList = blockList.concat(initGotoComplex());
	}

	for(var i = 0; i < func.code.length;) {
		console.log(func.code[i]);

		var iGain = 1;

		var hasGotoComplex = functionContext.gotoComplex && functionContext.gotoComplex.okToUse && functionContext.gotoComplex.active; // this MUST be before compileInstruction for branching to work
		
		// optimize out alloca calls
		if(func.code[i].type == "set" && func.code[i].computation == [] && func.code[i].value == 0 &&
			func.code[i+1].type == "store" && func.code[i+1].destination.value == func.code[i].name) {

			func.code[i].value = func.code[i+1].src.value;
			iGain++;
		}

		// optimize out icmp in conditional branch
		if(func.code[i].type == "set" && func.code[i].val.type == "comparison" &&
			func.code[i+1].type == "branch" && func.code[i+1].conditional && func.code[i+1].condition == func.code[i].name) {

			func.code[i] = {
				type: "branch",
				conditional: true,
				dest: func.code[i+1].dest,
				falseDest: func.code[i+1].falseDest,
				condition: icmpBlock(functionContext, func.code[i]),
				rawCondition: true
			};

			iGain++;
		}

		var instruction = compileInstruction(functionContext, func.code[i]);

		if(!functionContext.gotoInit && functionContext.gotoComplex && functionContext.gotoComplex.okToUse) {
			blockList = blockList.concat([functionContext.gotoComplex.forever]);
			functionContext.gotoInit = true;
		}
		if(hasGotoComplex) {
			if(functionContext.gotoComplex.currentContext[2]) {
				functionContext.gotoComplex.currentContext[2] =
					functionContext.gotoComplex.currentContext[2].concat(instruction);
			} else {
				functionContext.gotoComplex.currentContext[2] = instruction;
			}
		} else {
			blockList = blockList.concat(instruction);
		}

		i += iGain;
	}

	//blockList = blockList.concat(returnBlock());

	return blockList;
}

function compileInstruction(ctx, block) {
	if(block.type == "call") {
		// calling a (potentially foreign) function
		return callBlock(ctx, block);
	} else if(block.type == "ffi") {
		// FFI block
		// load the code from the options
		return module.exports.ffi[block.ffiBlock];
	} else if(block.type == "set") {
		var val = 0;

		console.log("SET: "+JSON.stringify(block));

		if(block.val.type == "return value") {
			val = ["readVariable", "return value"];
		} else if(block.val.type == "variable") {
			val = fetchByName(ctx, block.val.name);
		} else if(block.val.type == "arithmetic") {
			val = [block.val.operation, fetchByName(ctx, block.val.operand1), fetchByName(ctx, block.val.operand2)];
		} else if(block.val.type == "comparison") {
			val = icmpBlock(ctx, val);
		}

		return compileInstruction(ctx, block.computation)
				.concat(allocateLocal(ctx, val, block.name));
	} else if(block.type == "ret") {
		return returnBlock(ctx, block.value);
	} else if(block.type == "store") {
		return dereferenceAndSet(ctx, block.destination.value, block.src.value);
	} else if(block.type == "gotoComplex") {
		ctx.gotoComplex = {
			context: [],
			okToUse: false,
			forever: ["doForever", []],
			active: true
		}

		//return [ctx.gotoComplex.forever];
	} else if(block.type == "label") {
		if(ctx.scoped) {
			ctx.gotoComplex.currentContext[2] =
				ctx.gotoComplex.currentContext[2].concat(freeLocals(ctx));
		}

		ctx.scoped = true;

		var chunk = ["doIfElse", ["=", getCurrentLabel(), block.label], [], []];

		ctx.gotoComplex.okToUse = true;
		ctx.gotoComplex.active = true;

		if(ctx.gotoComplex.currentContext) {
			ctx.gotoComplex.currentContext[3] = [chunk];
			ctx.gotoComplex.currentContext = ctx.gotoComplex.currentContext[3][0];
		} else {
			ctx.gotoComplex.currentContext = chunk;
			ctx.gotoComplex.context = ctx.gotoComplex.currentContext;
			ctx.gotoComplex.forever[1] = [ctx.gotoComplex.context];
		}

	} else if(block.type == "branch") {
		ctx.gotoComplex.active = false;

		if(block.conditional) {
			var cond = block.rawCondition ? block.condition : ["=", fetchByName(ctx, block.condition), 1];

			return [
				["doIfElse", cond, absoluteBranch(block.dest.slice(1)), absoluteBranch(block.falseDest.slice(1))]
			];
		} else {
			return absoluteBranch(block.dest);
		}
	}

	return [];
}

// fixme: stub
function defaultForType(type) {
	console.log(type);
	return 0;
}

// fixme: stub
function specifierForType(type) {
	return "%s";
}

// fixme: stub
function formatValue(ctx, type, value) { 
	console.log("FORMAT: "+type+","+value);

	if(value[0] == '%') {
		return fetchByName(ctx, value);
	}

	return value;
}

function getOffset(ctx, value) {
	return ctx.globalLocalDepth + ctx.scopedLocalDepth - ctx.locals[value];
}

function stackPosFromOffset(offset) {
	// optimize zero-index
	if(offset == 0) {
		return "last";
	}

	return ["-", ["lineCountOfList:", "Stack"], offset];
}

// higher-level code generation

function allocateLocal(ctx, val, name) {
	if(name) {
		console.log(name+","+val);
		
		var depth = 0;

		if(ctx.scoped) {
			depth = ctx.globalLocalDepth + (++ctx.scopedLocalDepth);
		} else {
			depth = ctx.globalLocalDepth;
		}

		ctx.locals[name] = depth;
	}

	ctx.globalToFree++;
	
	if(ctx.scoped) {
		ctx.scopeToFree++;
	}

	return [
		["append:toList:", val, "Stack"]
	];
}

function freeStack(num) {
	return [
		["doRepeat", num, [["deleteLine:ofList:", "last", "Stack"]]],
	];
}

function freeLocals(ctx) {
	var numToFree = ctx.globalToFree;

	if(ctx.scoped) {
		numToFree = ctx.scopeToFree;
		ctx.scopeToFree = 0;
		ctx.scopedLocalDepth = 0;
	}

	return freeStack(numToFree);
}

function fetchByName(ctx, n) {
	if(ctx.locals[n] !== undefined)
		return ["getLine:ofList:", stackPosFromOffset(getOffset(ctx, n)), "Stack"];
	else if(ctx.params.indexOf(n) > -1)
		return ["getParam", n, "r"];
	else if( (n * 1) == n)
		return n
	else
		return ["undefined"];
}

function returnBlock(ctx, val) {
	var proc = freeLocals(ctx);
	
	if(ctx.gotoComplex) {
		proc = proc.concat(cleanGotoComplex());
	}

	if(val) {
		proc.push(["setVar:to:", "return value", formatValue(ctx, val[0], val[1])]);
	}

	proc.push(["stopScripts", "this script"]);

	return proc;
}

function callBlock(ctx, block) {
	var spec = block.funcName;
	var args = [];


	for(var a = 0; a < block.paramList.length; ++a) {
		args.push(formatValue(ctx, block.paramList[a][0], block.paramList[a][1]));
		spec += " "+specifierForType(block.paramList[a][0]);
	}

	return [
		["call", spec].concat(args)
	];
}

// TODO: more robust implementation to support heap

function dereferenceAndSet(ctx, ptr, content) {
	return [
		[
			"setLine:ofList:to:",
			stackPosFromOffset(getOffset(ctx, ptr)),
			"Stack",
			fetchByName(ctx, content)
		]
	];
}

function specForComparison(comp) {
	if(comp == "eq") {
		return "=";
	} else if(comp == "ne") {
		return "!=";
	} else if(comp == "slt" || comp == "ult") {
		return "<";
	} else if(comp == "sgt" || comp == "ugt") {
		return ">";
	}
	return "undefined";
}

function initGotoComplex() {
	return [
		["append:toList:", 0, "Label Stack"]
	];
}

function getCurrentLabel() {
	return ["getLine:ofList:", "last", "Label Stack"];
}

function cleanGotoComplex() {
	return [
		["deleteLine:ofList:", "last", "Label Stack"]
	];
}

function absoluteBranch(dest) {
	return [
		["setLine:ofList:to:", "last", "Label Stack", dest]
	];
}

function castToNumber(b) {
	return ["*", b, 1];
}

function icmpBlock(ctx, block) {
	var spec = specForComparison(block.val.operation);
	var negate = false;

	if(spec[0] == "!") {
		negate = true;
		spec = spec.slice(1);
	}

	var b = [spec, fetchByName(ctx, block.val.left), fetchByName(ctx, block.val.right)];

	if(negate) {
		b = ["not", b];
	}

	return castToNumber(b);
}

function getTypeSize(type) {
	return 4;
}