// src/worker.ts
// 1. Import the Rust initialization and the scanner function
import init, { scan_genomes } from '../wasm-lib/pkg/wasm_lib.js';

// 2. Listen for messages sent from the main UI thread
self.onmessage = async (event) => {
    // Unpack the data sent from the UI
    const { primersFasta, samplesFasta, fwdKeyword, revKeyword } = event.data;

    try {
        // Initialize the WebAssembly module
        await init();

        // Create the JavaScript callback that Rust will trigger
        const progressCallback = (percent: number) => {
            // Send a progress message to the Main UI
            self.postMessage({ type: 'progress', percent: percent });
        };

        // RUN THE RUST ENGINE! (This happens in the background)
        const resultJsonString = scan_genomes(primersFasta, samplesFasta, fwdKeyword, revKeyword, progressCallback);

        // Parse the JSON string from Rust into actual JavaScript Objects
        const results = JSON.parse(resultJsonString);

        // Send the objects back to the main UI thread
        self.postMessage({ type: 'complete', success: true, data: results });
        
    } catch (error) {
        // If anything crashes, tell the UI
        self.postMessage({ success: false, error: String(error) });
    }
};
