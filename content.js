// Initialize connection status
let isConnected = false;

// Set up connection when content script loads
chrome.runtime.onConnect.addListener(port => {
    isConnected = true;
    port.onDisconnect.addListener(() => {
        isConnected = false;
    });
});

// On page load, run if enabled
(async function () {
    try {
        const { mapping, enabled } = await chrome.storage.sync.get(['mapping', 'enabled']);
        if (enabled && mapping && Object.keys(mapping).length > 0) {
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => {
                    applyReplacements(mapping);
                });
            } else {
                applyReplacements(mapping);
            }
        }
    } catch (error) {
        console.error('Error initializing content script:', error);
    }
})();

// Update message listener with error handling
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    try {
        if (request.action === 'replaceSelectedText') {
            const selection = window.getSelection();
            
            // Function to safely escape text for regex
            const escapeRegexStr = str => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                                         .replace(/\n/g, '\\n')
                                         .replace(/\r/g, '\\r');
            
            // Function to replace text in a node
            const replaceTextInNode = (node, range) => {
                if (node.nodeType === Node.TEXT_NODE) {
                    const nodeText = node.textContent;
                    const originalText = request.original;
                    
                    // For exact matches within the selection range
                    if (range && 
                        node === range.startContainer && 
                        node === range.endContainer) {
                        const beforeText = nodeText.substring(0, range.startOffset);
                        const afterText = nodeText.substring(range.endOffset);
                        node.textContent = beforeText + request.replacement + afterText;
                        return true;
                    }
                    
                    // For partial matches or nodes fully within the selection
                    if (nodeText.includes(originalText)) {
                        node.textContent = nodeText.replace(originalText, request.replacement);
                        return true;
                    }
                }
                return false;
            };

            try {
                const range = selection.getRangeAt(0);
                const container = range.commonAncestorContainer;
                let replaced = false;

                // If selection is within a single text node
                if (container.nodeType === Node.TEXT_NODE) {
                    replaced = replaceTextInNode(container, range);
                } else {
                    // Extract the selected text and verify it matches
                    const selectedText = range.toString();
                    if (selectedText === request.original) {
                        // Replace the entire range content
                        range.deleteContents();
                        const textNode = document.createTextNode(request.replacement);
                        range.insertNode(textNode);
                        replaced = true;
                    }
                }
                
                sendResponse({ success: replaced });
            } catch (error) {
                console.error('Error during replacement:', error);
                sendResponse({ success: false, error: error.message });
            }
            
            return true; // Keep message channel open for async response
        } else if (request.action === 'getSelectedText') {
            const selection = window.getSelection();
            const selectedText = selection.toString().trim();
            if (selectedText) {
                sendResponse({ 
                    success: true, 
                    text: selectedText,
                    context: getSelectionContext(selection)
                });
            } else {
                sendResponse({ success: false });
            }
        }
    } catch (error) {
        console.error('Error in message listener:', error);
        sendResponse({ success: false, error: error.message });
    }
    return true;
});

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
             .replace(/\n/g, '\\n')
             .replace(/\r/g, '\\r');
}

function applyReplacements(mapping) {
    // Validate mapping
    if (!mapping || Object.keys(mapping).length === 0) return;

    console.log('Starting replacements with mapping:', mapping);

    // Cache the compiled regexes - removed \b word boundaries, added handling for newlines
    const replacements = Object.entries(mapping).map(([original, replacement]) => ({
        regex: new RegExp(escapeRegex(original), 'g'),
        replacement
    }));

    // Batch process nodes for better performance
    const batchSize = 100;
    let pendingNodes = [];

    // Track replacement usage
    async function trackReplacement(original, replacement, context) {
        const stats = await chrome.storage.sync.get('replacementStats') || {};
        const key = `${original}:${replacement}`;
        
        if (!stats[key]) {
            stats[key] = {
                useCount: 0,
                contexts: [],
                lastUsed: null,
                effectiveness: null
            };
        }

        stats[key].useCount++;
        stats[key].lastUsed = new Date().toISOString();
        stats[key].contexts.push({
            url: window.location.href,
            context: context.substring(0, 100),
            timestamp: new Date().toISOString()
        });

        await chrome.storage.sync.set({ replacementStats: stats });
    }

    function processTextNode(node) {
        pendingNodes.push(node);
        if (pendingNodes.length >= batchSize) {
            processBatch();
        }
    }

    function processBatch() {
        pendingNodes.forEach(node => {
            const originalText = node.nodeValue;
            let newText = originalText;
            let changed = false;

            for (const { regex, replacement } of replacements) {
                if (regex.test(newText)) {
                    regex.lastIndex = 0;
                    if (newText !== originalText) {
                        trackReplacement(regex.source, replacement, originalText);
                    }
                    newText = newText.replace(regex, replacement);
                    changed = true;
                }
            }

            if (changed) {
                node.nodeValue = newText;
            }
        });
        pendingNodes = [];
    }

    function processNode(node) {
        if (!node) return;

        // Skip if node is in an excluded element
        if (node.nodeType === Node.ELEMENT_NODE &&
            (node.tagName === 'SCRIPT' ||
                node.tagName === 'STYLE' ||
                node.tagName === 'INPUT' ||
                node.tagName === 'TEXTAREA' ||
                node.isContentEditable)) {
            return;
        }

        // Process text nodes
        if (node.nodeType === Node.TEXT_NODE) {
            processTextNode(node);
            return;
        }

        // Recursively process child nodes
        const children = Array.from(node.childNodes);
        for (const child of children) {
            processNode(child);
        }
    }

    // Initial processing
    processNode(document.body);

    // Set up observer for dynamic content
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            // Process new nodes
            if (mutation.addedNodes.length) {
                mutation.addedNodes.forEach(node => {
                    processNode(node);
                });
            }
            // Process changed text
            else if (mutation.type === 'characterData') {
                processTextNode(mutation.target);
            }
        }
    });

    // Start observing
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
    });
}

// Add selection handling with persistent storage
document.addEventListener('mouseup', async () => {
    const selection = window.getSelection();
    const selectedText = selection.toString().trim();
    
    if (selectedText) {
        // Keep only the storage functionality
        const range = selection.getRangeAt(0);
        const selectionData = {
            text: selectedText,
            position: {
                top: window.scrollY + range.getBoundingClientRect().top,
                left: window.scrollX + range.getBoundingClientRect().left
            },
            timestamp: Date.now()
        };
        
        // Store in session storage
        sessionStorage.setItem('opptics_selection', JSON.stringify(selectionData));
        
        // Store in extension storage if available
        if (chrome?.storage?.local) {
            try {
                await chrome.storage.local.set({
                    lastSelection: selectionData
                });
            } catch (error) {
                console.log('Extension storage unavailable, using session storage only');
            }
        }
    }
});

// Restore context menu click handler
document.addEventListener('contextmenu', async (e) => {
    const selection = window.getSelection();
    const selectedText = selection.toString().trim();
    
    if (selectedText) {
        // Store the selection in local storage
        await chrome.storage.local.set({
            pendingSelection: {
                text: selectedText,
                context: getSelectionContext(selection),
                timestamp: Date.now()
            }
        });

        // Send message to open extension popup to AI Analysis tab
        chrome.runtime.sendMessage({
            action: 'openExtension',
            tab: 'analyze'
        });
    }
});

// Add message listener with error recovery
function setupMessageListener() {
    const listener = async (request, sender, sendResponse) => {
        if (request.action === 'replaceSelectedText') {
            try {
                // Try to get selection from session storage if needed
                const selection = window.getSelection();
                if (!selection.rangeCount) {
                    const stored = sessionStorage.getItem('opptics_selection');
                    if (stored) {
                        const data = JSON.parse(stored);
                        // Only use stored selection if it's recent (within last 5 seconds)
                        if (Date.now() - data.timestamp < 5000) {
                            const range = document.createRange();
                            const node = document.createTextNode(data.text);
                            range.selectNode(node);
                            selection.removeAllRanges();
                            selection.addRange(range);
                        }
                    }
                }

                if (selection.rangeCount > 0) {
                    const range = selection.getRangeAt(0);
                    const newText = document.createTextNode(request.replacement);
                    range.deleteContents();
                    range.insertNode(newText);
                    sendResponse({ success: true });
                }
            } catch (error) {
                console.error('Error replacing text:', error);
                sendResponse({ success: false, error: error.message });
            }
        }
        return true;
    };

    // Only set up Chrome message listener if API is available
    if (chrome?.runtime?.onMessage) {
        try {
            chrome.runtime.onMessage.removeListener(listener);
            chrome.runtime.onMessage.addListener(listener);
        } catch (error) {
            console.error('Error setting up message listener:', error);
        }
    }
}

// Initialize message listener
setupMessageListener();

// Add auto-reconnection logic with availability check
let reconnectInterval = null;
function setupReconnection() {
    if (reconnectInterval) {
        clearInterval(reconnectInterval);
    }
    
    reconnectInterval = setInterval(() => {
        if (chrome?.runtime?.id) {
            setupMessageListener();
            clearInterval(reconnectInterval);
            reconnectInterval = null;
        }
    }, 1000);
}

// Start reconnection process
setupReconnection();

// Add helper function to get context around selection
function getSelectionContext(selection) {
    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer;
    
    // Get surrounding text (up to 100 chars before and after)
    let context = '';
    if (container.nodeType === Node.TEXT_NODE) {
        const fullText = container.textContent;
        const start = Math.max(0, range.startOffset - 100);
        const end = Math.min(fullText.length, range.endOffset + 100);
        context = fullText.substring(start, end);
    }
    
    return context;
}