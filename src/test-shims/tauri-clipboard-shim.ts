// @test-skip: Browser shim; no-ops only.
let memory = "";
export async function readText(): Promise<string> { return memory; }
export async function writeText(text: string): Promise<void> { memory = text; }
