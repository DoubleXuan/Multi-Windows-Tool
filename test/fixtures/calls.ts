// Open this file in the Extension Development Host and place the cursor on processData.
export function main() { processData('a'); processData('b'); }
export function worker() { dispatch('c'); }
export function dispatch(value: string) { return processData(value); }
export function processData(value: string) { validate(value); return save(value); }
export function validate(value: string) { return value.length > 0; }
export function save(value: string) { return value.trim(); }
export function recursive(n: number): number { return n > 0 ? recursive(n - 1) : 0; }
export namespace One { export function same() { return validate('one'); } }
export namespace Two { export function same() { return validate('two'); } }
