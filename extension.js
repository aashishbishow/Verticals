"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
const vscode = require("vscode");
const axios_1 = require("axios");
const querystring = require("querystring");
const timers_1 = require("timers");
// Instagram Graph API Configuration
const INSTAGRAM_CLIENT_ID = "YOUR_INSTAGRAM_CLIENT_ID";
const INSTAGRAM_CLIENT_SECRET = "YOUR_INSTAGRAM_CLIENT_SECRET";
const INSTAGRAM_REDIRECT_URI = "http://localhost:3000/callback";
const INSTAGRAM_AUTH_URL = "https://api.instagram.com/oauth/authorize";
const INSTAGRAM_TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const INSTAGRAM_GRAPH_BASE_URL = "https://graph.instagram.com/v20.0"; // Updated to latest version
// Entry point when extension is activated
function activate(context) {
    console.log("Instagram Reels extension is now active");
    // Register commands
    const disposables = [
        vscode.commands.registerCommand("verticals.openReels", () => {
            ReelsPanel.createOrShow(vscode.Uri.file(context.extensionPath), context);
        }),
        vscode.commands.registerCommand("verticals.loginInstagram", () => {
            loginToInstagram(context);
        }),
        vscode.commands.registerCommand("verticals.customFeed", () => {
            promptForCustomFeed(context);
        }),
        vscode.commands.registerCommand("verticals.setTimer", () => {
            promptForProductivityTimer(context);
        }),
        // Register keyboard shortcut commands
        vscode.commands.registerCommand("verticals.nextReel", () => {
            ReelsPanel.currentPanel?.navigateReels(1);
        }),
        vscode.commands.registerCommand("verticals.prevReel", () => {
            ReelsPanel.currentPanel?.navigateReels(-1);
        }),
        vscode.commands.registerCommand("verticals.togglePlay", () => {
            ReelsPanel.currentPanel?.togglePlayPause();
        }),
        // Register keybindings
        vscode.commands.registerCommand("verticals.registerKeybindings", () => {
            vscode.window.showInformationMessage("Keyboard shortcuts registered for Instagram Reels");
        }),
    ];
    context.subscriptions.push(...disposables);
}
exports.activate = activate;
/**
 * Initiate the OAuth flow for Instagram
 */
async function loginToInstagram(context) {
    try {
        // Create the authorization URL with required scopes
        const authUrl = `${INSTAGRAM_AUTH_URL}?client_id=${INSTAGRAM_CLIENT_ID}&redirect_uri=${encodeURIComponent(INSTAGRAM_REDIRECT_URI)}&scope=user_profile,user_media&response_type=code`;
        // Open the authorization URL in the user's browser
        await vscode.env.openExternal(vscode.Uri.parse(authUrl));
        // Prompt the user to enter the authorization code they receive
        const authCode = await vscode.window.showInputBox({
            prompt: "Enter the authorization code from Instagram",
            placeHolder: "Paste the code here...",
            ignoreFocusOut: true,
        });
        if (!authCode || authCode.trim() === "") {
            vscode.window.showWarningMessage("Authorization code is required to login.");
            return;
        }
        // Show progress while exchanging code for token
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Logging in to Instagram...",
            cancellable: false,
        }, async (progress) => {
            try {
                // Exchange the authorization code for an access token
                const tokenResponse = await axios_1.default.post(INSTAGRAM_TOKEN_URL, querystring.stringify({
                    client_id: INSTAGRAM_CLIENT_ID,
                    client_secret: INSTAGRAM_CLIENT_SECRET,
                    grant_type: "authorization_code",
                    redirect_uri: INSTAGRAM_REDIRECT_URI,
                    code: authCode.trim(),
                }), {
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                    timeout: 10000, // 10 second timeout
                });
                const accessToken = tokenResponse.data.access_token;
                if (!accessToken) {
                    throw new Error("No access token received from Instagram");
                }
                // Save the access token in global state
                await context.globalState.update("instagramAccessToken", accessToken);
                vscode.window.showInformationMessage("Successfully logged in to Instagram!");
                // If panel is open, refresh it
                if (ReelsPanel.currentPanel) {
                    ReelsPanel.currentPanel.refreshReels();
                }
            }
            catch (error) {
                const err = error;
                let errorMessage = "Login failed";
                if (err.response?.data?.error_description) {
                    errorMessage = `Login failed: ${err.response.data.error_description}`;
                }
                else if (err.message) {
                    errorMessage = `Login failed: ${err.message}`;
                }
                vscode.window.showErrorMessage(errorMessage);
                console.error("Instagram login error:", error);
                throw error;
            }
        });
    }
    catch (error) {
        console.error("Instagram login error:", error);
    }
}
/**
 * Prompt for custom feed (hashtag search)
 */
async function promptForCustomFeed(context) {
    const hashtag = await vscode.window.showInputBox({
        prompt: "Enter a hashtag to search for reels",
        placeHolder: "Enter hashtag without # symbol",
        validateInput: (value) => {
            if (!value || value.trim() === "") {
                return "Hashtag cannot be empty";
            }
            if (value.includes("#")) {
                return "Please enter hashtag without # symbol";
            }
            return null;
        },
    });
    if (hashtag && hashtag.trim() !== "") {
        const cleanHashtag = hashtag.trim();
        // Save the hashtag in workspace state
        await context.workspaceState.update("instagramHashtag", cleanHashtag);
        // Open or refresh the panel
        if (ReelsPanel.currentPanel) {
            ReelsPanel.currentPanel.setHashtag(cleanHashtag);
            ReelsPanel.currentPanel.refreshReels();
        }
        else {
            ReelsPanel.createOrShow(vscode.Uri.file(context.extensionPath), context, cleanHashtag);
        }
    }
}
/**
 * Prompt for productivity timer setup
 */
async function promptForProductivityTimer(context) {
    // Get the current timer setting
    const currentTimer = context.globalState.get("instagramTimerMinutes", 15);
    const minutes = await vscode.window.showInputBox({
        prompt: "Set time limit for reel watching (in minutes)",
        placeHolder: "Enter number of minutes (1-120)",
        value: currentTimer.toString(),
        validateInput: (value) => {
            const num = parseInt(value);
            if (isNaN(num) || num < 1 || num > 120) {
                return "Please enter a number between 1 and 120";
            }
            return null;
        },
    });
    if (minutes) {
        const timerMinutes = parseInt(minutes);
        await context.globalState.update("instagramTimerMinutes", timerMinutes);
        vscode.window.showInformationMessage(`Productivity timer set to ${timerMinutes} minutes`);
        // Update current panel if open
        if (ReelsPanel.currentPanel) {
            ReelsPanel.currentPanel.setProductivityTimer(timerMinutes);
        }
    }
}
// Panel Class for Instagram Reels
class ReelsPanel {
    constructor(panel, extensionUri, context, hashtag) {
        this.activeReels = [];
        this.currentReelIndex = 0;
        this.productivityTimerMinutes = 15;
        this.disposables = [];
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.context = context;
        this.hashtag = hashtag;
        // Set context for keyboard shortcuts
        vscode.commands.executeCommand("setContext", "instagramReelsViewerActive", true);
        // Setup event handlers
        this.disposables.push(this.panel.onDidDispose(() => this.dispose()), this.panel.webview.onDidReceiveMessage(this.handleMessage.bind(this)));
        // Load saved settings
        this.loadSettings();
        // Initialize content
        this.loadReels();
    }
    /**
     * Load saved settings from context
     */
    loadSettings() {
        this.productivityTimerMinutes = this.context.globalState.get("instagramTimerMinutes", 15);
        this.accessToken = this.context.globalState.get("instagramAccessToken");
        // Load hashtag from workspace state if not provided
        if (!this.hashtag) {
            this.hashtag =
                this.context.workspaceState.get("instagramHashtag");
        }
    }
    /**
     * Create or show the panel
     */
    static createOrShow(extensionUri, context, hashtag) {
        // If the panel already exists, reveal it
        if (ReelsPanel.currentPanel) {
            ReelsPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
            if (hashtag) {
                ReelsPanel.currentPanel.setHashtag(hashtag);
                ReelsPanel.currentPanel.refreshReels();
            }
            return;
        }
        // Otherwise, create a new panel
        const panel = vscode.window.createWebviewPanel("instaReels", "📸 Insta Reels", vscode.ViewColumn.One, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [extensionUri],
        });
        ReelsPanel.currentPanel = new ReelsPanel(panel, extensionUri, context, hashtag);
    }
    /**
     * Handle messages from the webview
     */
    async handleMessage(message) {
        try {
            switch (message.command) {
                case "next":
                    this.navigateReels(1);
                    break;
                case "previous":
                    this.navigateReels(-1);
                    break;
                case "login":
                    await vscode.commands.executeCommand("verticals.loginInstagram");
                    break;
                case "customFeed":
                    await vscode.commands.executeCommand("verticals.customFeed");
                    break;
                case "setTimer":
                    await vscode.commands.executeCommand("verticals.setTimer");
                    break;
                case "retry":
                    this.refreshReels();
                    break;
                case "timerExpired":
                    vscode.window.showWarningMessage("Your reel watching time limit has been reached!");
                    this.dispose();
                    break;
                default:
                    console.warn("Unknown message command:", message.command);
            }
        }
        catch (error) {
            console.error("Error handling message:", error);
            vscode.window.showErrorMessage(`Error: ${error.message}`);
        }
    }
    /**
     * Set or change the hashtag filter
     */
    setHashtag(hashtag) {
        this.hashtag = hashtag;
        this.context.workspaceState.update("instagramHashtag", hashtag);
    }
    /**
     * Set the productivity timer duration
     */
    setProductivityTimer(minutes) {
        this.productivityTimerMinutes = minutes;
        this.restartProductivityTimer();
    }
    /**
     * Navigate between reels
     */
    navigateReels(direction) {
        if (!this.activeReels || this.activeReels.length === 0) {
            return;
        }
        this.currentReelIndex =
            (this.currentReelIndex + direction + this.activeReels.length) %
                this.activeReels.length;
        this.update();
    }
    /**
     * Toggle play/pause for the current reel
     */
    togglePlayPause() {
        this.panel.webview.postMessage({ command: "togglePlay" });
    }
    /**
     * Refresh the reels content
     */
    refreshReels() {
        this.loadReels();
    }
    /**
     * Load reels from Instagram API
     */
    async loadReels() {
        // Refresh access token from context
        this.accessToken = this.context.globalState.get("instagramAccessToken");
        if (!this.accessToken) {
            this.showLoginPrompt();
            return;
        }
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Loading reels...",
                cancellable: false,
            }, async (progress) => {
                let reels = [];
                if (this.hashtag) {
                    progress.report({ message: `Searching hashtag: ${this.hashtag}` });
                    reels = await this.fetchReelsByHashtag(this.hashtag);
                }
                else {
                    progress.report({ message: "Loading your reels" });
                    reels = await this.fetchPersonalReels();
                }
                if (reels.length > 0) {
                    this.activeReels = reels;
                    this.currentReelIndex = 0;
                    this.update();
                    this.startProductivityTimer();
                }
                else {
                    this.showNoReelsMessage();
                }
            });
        }
        catch (error) {
            const err = error;
            let errorMessage = "Failed to load reels";
            if (err.response?.status === 401) {
                errorMessage = "Instagram login expired. Please log in again.";
                // Clear the expired token
                await this.context.globalState.update("instagramAccessToken", undefined);
                this.accessToken = undefined;
            }
            else if (err.response?.data?.error?.message) {
                errorMessage = `Failed to load reels: ${err.response.data.error.message}`;
            }
            else if (err.message) {
                errorMessage = `Failed to load reels: ${err.message}`;
            }
            vscode.window.showErrorMessage(errorMessage);
            this.showErrorMessage(errorMessage);
            console.error("Load reels error:", error);
        }
    }
    /**
     * Fetch user's personal reels from Instagram API
     */
    async fetchPersonalReels() {
        const response = await axios_1.default.get(`${INSTAGRAM_GRAPH_BASE_URL}/me/media`, {
            params: {
                access_token: this.accessToken,
                fields: "id,media_type,media_url,thumbnail_url,permalink,caption,timestamp",
                limit: 25,
            },
            timeout: 15000,
        });
        // Filter for only reels (video type)
        return response.data.data.filter((item) => item.media_type === "VIDEO" ||
            (item.media_type === "CAROUSEL_ALBUM" &&
                item.children &&
                item.children.data.some((child) => child.media_type === "VIDEO")));
    }
    /**
     * Fetch reels by hashtag from Instagram API
     */
    async fetchReelsByHashtag(hashtag) {
        // First, get the hashtag ID
        const hashtagResponse = await axios_1.default.get(`${INSTAGRAM_GRAPH_BASE_URL}/ig_hashtag_search`, {
            params: {
                access_token: this.accessToken,
                q: hashtag,
            },
            timeout: 15000,
        });
        if (!hashtagResponse.data.data.length) {
            throw new Error(`Hashtag #${hashtag} not found`);
        }
        const hashtagId = hashtagResponse.data.data[0].id;
        // Now fetch media from this hashtag
        const response = await axios_1.default.get(`${INSTAGRAM_GRAPH_BASE_URL}/${hashtagId}/top_media`, {
            params: {
                access_token: this.accessToken,
                fields: "id,media_type,media_url,thumbnail_url,permalink,caption,timestamp",
                limit: 25,
            },
            timeout: 15000,
        });
        // Filter for only reels (video type)
        return response.data.data.filter((item) => item.media_type === "VIDEO" ||
            (item.media_type === "CAROUSEL_ALBUM" &&
                item.children &&
                item.children.data.some((child) => child.media_type === "VIDEO")));
    }
    /**
     * Start or restart the productivity timer
     */
    startProductivityTimer() {
        this.clearProductivityTimer();
        // Set new timer
        this.timerHandle = (0, timers_1.setTimeout)(() => {
            vscode.window.showWarningMessage("Your reel watching time limit has been reached!");
            this.dispose();
        }, this.productivityTimerMinutes * 60 * 1000);
    }
    /**
     * Restart the productivity timer
     */
    restartProductivityTimer() {
        this.clearProductivityTimer();
        this.startProductivityTimer();
        this.update(); // Update the UI to show new timer
    }
    /**
     * Clear the productivity timer
     */
    clearProductivityTimer() {
        if (this.timerHandle) {
            (0, timers_1.clearTimeout)(this.timerHandle);
            this.timerHandle = undefined;
        }
    }
    /**
     * Update the webview content
     */
    update() {
        if (this.activeReels.length > 0) {
            this.panel.webview.html = this.getReelHtmlContent(this.activeReels[this.currentReelIndex]);
        }
    }
    /**
     * Clean up resources
     */
    dispose() {
        ReelsPanel.currentPanel = undefined;
        // Clear timer
        this.clearProductivityTimer();
        // Reset context for keyboard shortcuts
        vscode.commands.executeCommand("setContext", "instagramReelsViewerActive", false);
        // Dispose all disposables
        this.disposables.forEach((d) => d.dispose());
        this.disposables = [];
        // Dispose panel
        this.panel.dispose();
    }
    /**
     * Show login prompt
     */
    showLoginPrompt() {
        this.panel.webview.html = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Instagram Reels</title>
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
                        padding: 20px;
                        margin: 0;
                        background-color: #121212;
                        color: white;
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;
                        height: 100vh;
                        text-align: center;
                    }
                    .login-container {
                        background-color: #262626;
                        padding: 30px;
                        border-radius: 8px;
                        max-width: 400px;
                    }
                    button {
                        background-color: #0095f6;
                        color: white;
                        border: none;
                        padding: 10px 20px;
                        border-radius: 4px;
                        font-size: 16px;
                        cursor: pointer;
                        margin-top: 20px;
                        transition: background-color 0.2s;
                    }
                    button:hover {
                        background-color: #0074cc;
                    }
                    h2 {
                        margin-top: 0;
                    }
                </style>
            </head>
            <body>
                <div class="login-container">
                    <h2>📸 Instagram Reels Viewer</h2>
                    <p>You need to log in to Instagram to view reels.</p>
                    <button id="loginButton">Login to Instagram</button>
                </div>
                
                <script>
                    const vscode = acquireVsCodeApi();
                    document.getElementById('loginButton').addEventListener('click', () => {
                        vscode.postMessage({
                            command: 'login'
                        });
                    });
                </script>
            </body>
            </html>
        `;
    }
    /**
     * Show no reels found message
     */
    showNoReelsMessage() {
        this.panel.webview.html = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Instagram Reels</title>
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
                        padding: 20px;
                        margin: 0;
                        background-color: #121212;
                        color: white;
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;
                        height: 100vh;
                        text-align: center;
                    }
                    .message-container {
                        background-color: #262626;
                        padding: 30px;
                        border-radius: 8px;
                        max-width: 400px;
                    }
                    button {
                        background-color: #0095f6;
                        color: white;
                        border: none;
                        padding: 10px 20px;
                        border-radius: 4px;
                        font-size: 16px;
                        cursor: pointer;
                        margin: 10px 5px;
                        transition: background-color 0.2s;
                    }
                    button:hover {
                        background-color: #0074cc;
                    }
                    h2 {
                        margin-top: 0;
                    }
                </style>
            </head>
            <body>
                <div class="message-container">
                    <h2>No Reels Found</h2>
                    <p>No reels were found. Try searching for a different hashtag or check your Instagram account.</p>
                    <button id="customFeedButton">Search Hashtag</button>
                    <button id="retryButton">Retry</button>
                </div>
                
                <script>
                    const vscode = acquireVsCodeApi();
                    document.getElementById('customFeedButton').addEventListener('click', () => {
                        vscode.postMessage({
                            command: 'customFeed'
                        });
                    });
                    document.getElementById('retryButton').addEventListener('click', () => {
                        vscode.postMessage({
                            command: 'retry'
                        });
                    });
                </script>
            </body>
            </html>
        `;
    }
    /**
     * Show error message
     */
    showErrorMessage(message) {
        // Escape HTML to prevent XSS
        const escapedMessage = message
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
        this.panel.webview.html = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Instagram Reels</title>
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
                        padding: 20px;
                        margin: 0;
                        background-color: #121212;
                        color: white;
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;
                        height: 100vh;
                        text-align: center;
                    }
                    .error-container {
                        background-color: #262626;
                        padding: 30px;
                        border-radius: 8px;
                        max-width: 400px;
                    }
                    button {
                        background-color: #0095f6;
                        color: white;
                        border: none;
                        padding: 10px 20px;
                        border-radius: 4px;
                        font-size: 16px;
                        cursor: pointer;
                        margin: 10px 5px;
                        transition: background-color 0.2s;
                    }
                    button:hover {
                        background-color: #0074cc;
                    }
                    h2 {
                        margin-top: 0;
                        color: #ff3b30;
                    }
                </style>
            </head>
            <body>
                <div class="error-container">
                    <h2>Error</h2>
                    <p>${escapedMessage}</p>
                    <button id="retryButton">Retry</button>
                    <button id="loginButton">Login Again</button>
                </div>
                
                <script>
                    const vscode = acquireVsCodeApi();
                    document.getElementById('retryButton').addEventListener('click', () => {
                        vscode.postMessage({
                            command: 'retry'
                        });
                    });
                    document.getElementById('loginButton').addEventListener('click', () => {
                        vscode.postMessage({
                            command: 'login'
                        });
                    });
                </script>
            </body>
            </html>
        `;
    }
    /**
     * Generate HTML content for a reel
     */
    getReelHtmlContent(reel) {
        const mediaUrl = reel.media_url || (reel.thumbnail_url ? reel.thumbnail_url : "");
        const caption = (reel.caption || "No caption")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Instagram Reels</title>
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
                        padding: 0;
                        margin: 0;
                        background-color: #121212;
                        color: white;
                    }
                    .container {
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        padding: 20px;
                    }
                    .video-container {
                        width: 100%;
                        max-width: 400px;
                        position: relative;
                    }
                    video {
                        width: 100%;
                        height: auto;
                        border-radius: 8px;
                        max-height: 70vh;
                    }
                    .caption {
                        margin-top: 16px;
                        padding: 12px;
                        background-color: #262626;
                        border-radius: 8px;
                        width: 100%;
                        max-width: 400px;
                        word-wrap: break-word;
                        max-height: 100px;
                        overflow-y: auto;
                    }
                    .controls {
                        display: flex;
                        justify-content: space-between;
                        width: 100%;
                        max-width: 400px;
                        margin-top: 16px;
                    }
                    button {
                        background-color: #0095f6;
                        color: white;
                        border: none;
                        padding: 8px 16px;
                        border-radius: 4px;
                        cursor: pointer;
                        transition: background-color 0.2s;
                    }
                    button:hover {
                        background-color: #0074cc;
                    }
                    .timer {
                        margin-top: 16px;
                        font-size: 14px;
                        color: #8e8e8e;
                    }

.keyboard-shortcuts {
                        margin-top: 20px;
                        font-size: 12px;
                        color: #8e8e8e;
                        text-align: center;
                        padding: 12px;
                        background-color: #1a1a1a;
                        border-radius: 6px;
                        max-width: 400px;
                        width: 100%;
                    }
                    .shortcut {
                        margin: 4px 0;
                    }
                    .key {
                        background-color: #333;
                        padding: 2px 6px;
                        border-radius: 3px;
                        font-family: monospace;
                    }
                    .timestamp {
                        margin-top: 8px;
                        font-size: 12px;
                        color: #8e8e8e;
                    }
                    .navigation-info {
                        margin-top: 10px;
                        font-size: 14px;
                        color: #8e8e8e;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="video-container">
                        <video id="reelVideo" controls autoplay loop>
                            <source src="${mediaUrl}" type="video/mp4">
                            Your browser does not support the video tag.
                        </video>
                    </div>
                    
                    <div class="navigation-info">
                        ${this.currentReelIndex + 1} of ${this.activeReels.length} reels
                        ${this.hashtag ? `• #${this.hashtag}` : "• Your reels"}
                    </div>
                    
                    <div class="caption">
                        ${caption}
                    </div>
                    
                    <div class="timestamp">
                        ${new Date(reel.timestamp).toLocaleString()}
                    </div>
                    
                    <div class="controls">
                        <button id="prevButton">Previous</button>
                        <button id="nextButton">Next</button>
                    </div>
                    
                    <div class="timer">
                        Time limit: ${this.productivityTimerMinutes} minutes
                    </div>
                    
                    <div class="keyboard-shortcuts">
                        <div class="shortcut"><span class="key">←</span> Previous reel</div>
                        <div class="shortcut"><span class="key">→</span> Next reel</div>
                        <div class="shortcut"><span class="key">Space</span> Play/Pause</div>
                        <div class="shortcut"><span class="key">Ctrl+Shift+H</span> Search hashtag</div>
                        <div class="shortcut"><span class="key">Ctrl+Shift+T</span> Set timer</div>
                    </div>
                </div>
                
                <script>
                    const vscode = acquireVsCodeApi();
                    
                    // Navigation buttons
                    document.getElementById('prevButton').addEventListener('click', () => {
                        vscode.postMessage({
                            command: 'previous'
                        });
                    });
                    
                    document.getElementById('nextButton').addEventListener('click', () => {
                        vscode.postMessage({
                            command: 'next'
                        });
                    });
                    
                    // Keyboard shortcuts
                    document.addEventListener('keydown', (event) => {
                        switch(event.key) {
                            case 'ArrowLeft':
                                event.preventDefault();
                                vscode.postMessage({ command: 'previous' });
                                break;
                            case 'ArrowRight':
                                event.preventDefault();
                                vscode.postMessage({ command: 'next' });
                                break;
                            case ' ':
                                event.preventDefault();
                                const video = document.getElementById('reelVideo');
                                if (video.paused) {
                                    video.play();
                                } else {
                                    video.pause();
                                }
                                break;
                        }
                    });
                    
                    // Handle video play/pause messages from extension
                    window.addEventListener('message', event => {
                        const message = event.data;
                        if (message.command === 'togglePlay') {
                            const video = document.getElementById('reelVideo');
                            if (video.paused) {
                                video.play();
                            } else {
                                video.pause();
                            }
                        }
                    });
                    
                    // Auto-focus for keyboard shortcuts
                    document.body.focus();
                    
                    // Timer countdown (optional enhancement)
                    let timeLeft = ${this.productivityTimerMinutes} * 60;
                    const timerInterval = setInterval(() => {
                        timeLeft--;
                        if (timeLeft <= 0) {
                            clearInterval(timerInterval);
                            vscode.postMessage({ command: 'timerExpired' });
                        }
                    }, 1000);
                </script>
            </body>
            </html>
        `;
    }
}
// Export the deactivate function
function deactivate() {
    if (ReelsPanel.currentPanel) {
        ReelsPanel.currentPanel.dispose();
    }
}
exports.deactivate = deactivate;
//# sourceMappingURL=extension.js.map