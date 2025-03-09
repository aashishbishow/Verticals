import * as vscode from 'vscode';
import axios from 'axios';
import * as querystring from 'querystring';

// Instagram Graph API Configuration
const INSTAGRAM_CLIENT_ID = 'YOUR_INSTAGRAM_CLIENT_ID';
const INSTAGRAM_CLIENT_SECRET = 'YOUR_INSTAGRAM_CLIENT_SECRET';
const INSTAGRAM_REDIRECT_URI = 'http://localhost:3000/callback';
const INSTAGRAM_AUTH_URL = 'https://api.instagram.com/oauth/authorize';
const INSTAGRAM_TOKEN_URL = 'https://api.instagram.com/oauth/access_token';
const INSTAGRAM_GRAPH_BASE_URL = 'https://graph.instagram.com/v18.0';

// Interfaces for Instagram API responses
interface InstagramReel {
    id: string;
    media_type: string;
    media_url: string;
    thumbnail_url?: string;
    permalink: string;
    caption?: string;
    timestamp: string;
    children?: {
        data: InstagramReel[];
    };
}

interface InstagramResponse {
    data: InstagramReel[];
}

interface HashtagResponse {
    data: {
        id: string;
        name: string;
    }[];
}

// Entry point when extension is activated
export function activate(context: vscode.ExtensionContext) {
    console.log('Instagram Reels extension is now active');

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('verticals.openReels', () => {
            ReelsPanel.createOrShow(context.extensionUri);
        }),
        vscode.commands.registerCommand('verticals.loginInstagram', () => {
            loginToInstagram(context);
        }),
        vscode.commands.registerCommand('verticals.customFeed', () => {
            promptForCustomFeed(context);
        }),
        vscode.commands.registerCommand('verticals.setTimer', () => {
            promptForProductivityTimer(context);
        }),
        
        // Register keyboard shortcut commands
        vscode.commands.registerCommand('verticals.nextReel', () => {
            ReelsPanel.currentPanel?.navigateReels(1);
        }),
        vscode.commands.registerCommand('verticals.prevReel', () => {
            ReelsPanel.currentPanel?.navigateReels(-1);
        }),
        vscode.commands.registerCommand('verticals.togglePlay', () => {
            ReelsPanel.currentPanel?.togglePlayPause();
        })
    );

    // Register keybindings
    context.subscriptions.push(
        vscode.commands.registerCommand('verticals.registerKeybindings', () => {
            // This would typically update the keybindings.json file
            // For demonstration, we'll just show a message
            vscode.window.showInformationMessage('Keyboard shortcuts registered for Instagram Reels');
        })
    );
}

/**
 * Initiate the OAuth flow for Instagram
 */
async function loginToInstagram(context: vscode.ExtensionContext) {
    // Create the authorization URL with required scopes
    const authUrl = `${INSTAGRAM_AUTH_URL}?client_id=${INSTAGRAM_CLIENT_ID}&redirect_uri=${encodeURIComponent(INSTAGRAM_REDIRECT_URI)}&scope=user_profile,user_media&response_type=code`;
    
    // Open the authorization URL in the user's browser
    vscode.env.openExternal(vscode.Uri.parse(authUrl));
    
    // Prompt the user to enter the authorization code they receive
    const authCode = await vscode.window.showInputBox({
        prompt: 'Enter the authorization code from Instagram',
        placeHolder: 'Paste the code here...'
    });
    
    if (authCode) {
        try {
            // Exchange the authorization code for an access token
            const tokenResponse = await axios.post(INSTAGRAM_TOKEN_URL, querystring.stringify({
                client_id: INSTAGRAM_CLIENT_ID,
                client_secret: INSTAGRAM_CLIENT_SECRET,
                grant_type: 'authorization_code',
                redirect_uri: INSTAGRAM_REDIRECT_URI,
                code: authCode
            }));
            
            const accessToken = tokenResponse.data.access_token;
            
            // Save the access token in global state
            context.globalState.update('instagramAccessToken', accessToken);
            
            vscode.window.showInformationMessage('Successfully logged in to Instagram!');
            
            // If panel is open, refresh it
            ReelsPanel.currentPanel?.refreshReels();
        } catch (error) {
            const err = error as Error;
            vscode.window.showErrorMessage(`Login failed: ${err.message}`);
            console.error('Instagram login error:', error);
        }
    }
}

/**
 * Prompt for custom feed (hashtag search)
 */
async function promptForCustomFeed(context: vscode.ExtensionContext) {
    const hashtag = await vscode.window.showInputBox({
        prompt: 'Enter a hashtag to search for reels',
        placeHolder: 'Enter hashtag without # symbol'
    });
    
    if (hashtag) {
        // Save the hashtag in workspace state
        context.workspaceState.update('instagramHashtag', hashtag);
        
        // Open or refresh the panel
        if (ReelsPanel.currentPanel) {
            ReelsPanel.currentPanel.setHashtag(hashtag);
            ReelsPanel.currentPanel.refreshReels();
        } else {
            ReelsPanel.createOrShow(context.extensionUri, hashtag);
        }
    }
}

/**
 * Prompt for productivity timer setup
 */
async function promptForProductivityTimer(context: vscode.ExtensionContext) {
    // Get the current timer setting
    const currentTimer = context.globalState.get<number>('instagramTimerMinutes', 15);
    
    const minutes = await vscode.window.showInputBox({
        prompt: 'Set time limit for reel watching (in minutes)',
        placeHolder: 'Enter number of minutes',
        value: currentTimer.toString()
    });
    
    if (minutes && !isNaN(parseInt(minutes))) {
        const timerMinutes = parseInt(minutes);
        context.globalState.update('instagramTimerMinutes', timerMinutes);
        vscode.window.showInformationMessage(`Productivity timer set to ${timerMinutes} minutes`);
        
        // Update current panel if open
        if (ReelsPanel.currentPanel) {
            ReelsPanel.currentPanel.setProductivityTimer(timerMinutes);
        }
    }
}

// Panel Class for Instagram Reels
class ReelsPanel {
    public static currentPanel: ReelsPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private activeReels: InstagramReel[] = [];
    private currentReelIndex: number = 0;
    private hashtag: string | undefined;
    private productivityTimerMinutes: number = 15;
    private timerHandle: NodeJS.Timeout | undefined;
    private accessToken: string | undefined;
    
    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, hashtag?: string) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.hashtag = hashtag;
        
        // Set context for keyboard shortcuts
        vscode.commands.executeCommand('setContext', 'instagramReelsViewerActive', true);
        
        // Setup event handlers
        this.panel.onDidDispose(() => this.dispose(), null, []);
        this.panel.webview.onDidReceiveMessage(this.handleMessage.bind(this), undefined, []);
        
        // Load saved timer setting
        const context = this.getExtensionContext();
        if (context) {
            this.productivityTimerMinutes = context.globalState.get<number>('instagramTimerMinutes', 15);
            this.accessToken = context.globalState.get<string>('instagramAccessToken');
        }
        
        // Initialize content
        this.loadReels();
    }

    // Get the extension context
    private getExtensionContext(): vscode.ExtensionContext | undefined {
        // This is a workaround since we don't have direct access to the context
        // In a real extension, you might pass the context to the constructor
        return undefined;
    }

    /**
     * Create or show the panel
     */
    public static createOrShow(extensionUri: vscode.Uri, hashtag?: string) {
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
        const panel = vscode.window.createWebviewPanel(
            'instaReels',
            '📸 Insta Reels',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        ReelsPanel.currentPanel = new ReelsPanel(panel, extensionUri, hashtag);
    }

    /**
     * Handle messages from the webview
     */
    private handleMessage(message: any) {
        switch (message.command) {
            case 'next':
                this.navigateReels(1);
                break;
            case 'previous':
                this.navigateReels(-1);
                break;
            case 'timerExpired':
                vscode.window.showWarningMessage('Your reel watching time limit has been reached!');
                this.dispose();
                break;
        }
    }

    /**
     * Set or change the hashtag filter
     */
    public setHashtag(hashtag: string) {
        this.hashtag = hashtag;
    }

    /**
     * Set the productivity timer duration
     */
    public setProductivityTimer(minutes: number) {
        this.productivityTimerMinutes = minutes;
        this.restartProductivityTimer();
    }

    /**
     * Navigate between reels
     */
    public navigateReels(direction: number) {
        if (!this.activeReels || this.activeReels.length === 0) return;
        
        this.currentReelIndex = (this.currentReelIndex + direction + this.activeReels.length) % this.activeReels.length;
        this.update();
    }

    /**
     * Toggle play/pause for the current reel
     */
    public togglePlayPause() {
        this.panel.webview.postMessage({ command: 'togglePlay' });
    }

    /**
     * Refresh the reels content
     */
    public refreshReels() {
        this.loadReels();
    }

    /**
     * Load reels from Instagram API
     */
    private async loadReels() {
        if (!this.accessToken) {
            // Show login placeholder if not logged in
            this.showLoginPrompt();
            return;
        }
        
        try {
            let reels: InstagramReel[] = [];
            
            if (this.hashtag) {
                // Fetch reels by hashtag
                reels = await this.fetchReelsByHashtag(this.hashtag);
            } else {
                // Fetch user's personal reels
                reels = await this.fetchPersonalReels();
            }
            
            if (reels.length > 0) {
                this.activeReels = reels;
                this.currentReelIndex = 0;
                this.update();
                this.startProductivityTimer();
            } else {
                this.showNoReelsMessage();
            }
        } catch (error) {
            const err = error as Error;
            vscode.window.showErrorMessage(`Failed to load reels: ${err.message}`);
            this.showErrorMessage(err.message);
        }
    }

    /**
     * Fetch user's personal reels from Instagram API
     */
    private async fetchPersonalReels(): Promise<InstagramReel[]> {
        const response = await axios.get<InstagramResponse>(`${INSTAGRAM_GRAPH_BASE_URL}/me/media`, {
            params: {
                access_token: this.accessToken,
                fields: 'id,media_type,media_url,thumbnail_url,permalink,caption,timestamp'
            }
        });
        
        // Filter for only reels (video type)
        return response.data.data.filter(item => 
            item.media_type === 'VIDEO' || 
            (item.media_type === 'CAROUSEL_ALBUM' && item.children && 
             item.children.data.some(child => child.media_type === 'VIDEO'))
        );
    }

    /**
     * Fetch reels by hashtag from Instagram API
     */
    private async fetchReelsByHashtag(hashtag: string): Promise<InstagramReel[]> {
        // First, get the hashtag ID
        const hashtagResponse = await axios.get<HashtagResponse>(`${INSTAGRAM_GRAPH_BASE_URL}/ig_hashtag_search`, {
            params: {
                access_token: this.accessToken,
                q: hashtag
            }
        });
        
        if (!hashtagResponse.data.data.length) {
            throw new Error(`Hashtag #${hashtag} not found`);
        }
        
        const hashtagId = hashtagResponse.data.data[0].id;
        
        // Now fetch media from this hashtag
        const response = await axios.get<InstagramResponse>(`${INSTAGRAM_GRAPH_BASE_URL}/${hashtagId}/top_media`, {
            params: {
                access_token: this.accessToken,
                fields: 'id,media_type,media_url,thumbnail_url,permalink,caption,timestamp'
            }
        });
        
        // Filter for only reels (video type)
        return response.data.data.filter(item => 
            item.media_type === 'VIDEO' || 
            (item.media_type === 'CAROUSEL_ALBUM' && item.children && 
             item.children.data.some(child => child.media_type === 'VIDEO'))
        );
    }

    /**
     * Start or restart the productivity timer
     */
    private startProductivityTimer() {
        this.clearProductivityTimer();
        
        // Set new timer
        this.timerHandle = setTimeout(() => {
            vscode.window.showWarningMessage('Your reel watching time limit has been reached!');
            this.dispose();
        }, this.productivityTimerMinutes * 60 * 1000);
    }

    /**
     * Restart the productivity timer
     */
    private restartProductivityTimer() {
        this.clearProductivityTimer();
        this.startProductivityTimer();
        this.update(); // Update the UI to show new timer
    }

    /**
     * Clear the productivity timer
     */
    private clearProductivityTimer() {
        if (this.timerHandle) {
            clearTimeout(this.timerHandle);
            this.timerHandle = undefined;
        }
    }

    /**
     * Update the webview content
     */
    private update() {
        if (this.activeReels.length > 0) {
            this.panel.webview.html = this.getReelHtmlContent(this.activeReels[this.currentReelIndex]);
        }
    }

    /**
     * Clean up resources
     */
    public dispose() {
        ReelsPanel.currentPanel = undefined;
        
        // Clear timer
        this.clearProductivityTimer();
        
        // Reset context for keyboard shortcuts
        vscode.commands.executeCommand('setContext', 'instagramReelsViewerActive', false);
        
        // Dispose panel
        this.panel.dispose();
    }

    /**
     * Show login prompt
     */
    private showLoginPrompt() {
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
    private showNoReelsMessage() {
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
                        margin-top: 20px;
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
                </div>
                
                <script>
                    const vscode = acquireVsCodeApi();
                    document.getElementById('customFeedButton').addEventListener('click', () => {
                        vscode.postMessage({
                            command: 'customFeed'
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
    private showErrorMessage(message: string) {
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
                        margin-top: 20px;
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
                    <p>${message}</p>
                    <button id="retryButton">Retry</button>
                </div>
                
                <script>
                    const vscode = acquireVsCodeApi();
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
     * Generate HTML content for a reel
     */
    private getReelHtmlContent(reel: InstagramReel): string {
        const mediaUrl = reel.media_url || (reel.thumbnail_url ? reel.thumbnail_url : '');
        const caption = reel.caption || 'No caption';
        
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
                    }
                    .caption {
                        margin-top: 16px;
                        padding: 12px;
                        background-color: #262626;
                        border-radius: 8px;
                        width: 100%;
                        max-width: 400px;
                        word-wrap: break-word;
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
                        padding: 12px;
                        background-color: #262626;
                        border-radius: 8px;
                        width: 100%;
                        max-width: 400px;
                    }
                    .shortcut {
                        display: flex;
                        justify-content: space-between;
                        margin-bottom: 8px;
                    }
                    .custom-controls {
                        display: flex;
                        justify-content: space-between;
                        width: 100%;
                        max-width: 400px;
                        margin-top: 16px;
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
                    
                    <div class="caption">
                        <p>${caption}</p>
                    </div>
                    
                    <div class="controls">
                        <button id="prevButton">Previous</button>
                        <button id="toggleButton">Pause</button>
                        <button id="nextButton">Next</button>
                    </div>
                    
                    <div class="custom-controls">
                        <button id="customFeedButton">Search Hashtag</button>
                        <button id="timerButton">Set Timer</button>
                    </div>
                    
                    <div class="timer">
                        Time remaining: <span id="timeRemaining">${this.productivityTimerMinutes}:00</span>
                    </div>
                    
                    <div class="keyboard-shortcuts">
                        <h3>Keyboard Shortcuts</h3>
                        <div class="shortcut">
                            <span>Next Reel:</span>
                            <span>Ctrl+Shift+Right</span>
                        </div>
                        <div class="shortcut">
                            <span>Previous Reel:</span>
                            <span>Ctrl+Shift+Left</span>
                        </div>
                        <div class="shortcut">
                            <span>Play/Pause:</span>
                            <span>Ctrl+Shift+Space</span>
                        </div>
                    </div>
                </div>
                
                <script>
                    const vscode = acquireVsCodeApi();
                    const video = document.getElementById('reelVideo');
                    const toggleButton = document.getElementById('toggleButton');
                    const nextButton = document.getElementById('nextButton');
                    const prevButton = document.getElementById('prevButton');
                    const timeRemaining = document.getElementById('timeRemaining');
                    const customFeedButton = document.getElementById('customFeedButton');
                    const timerButton = document.getElementById('timerButton');
                    
                    let timerInterval;
                    let minutesLeft = ${this.productivityTimerMinutes};
                    let secondsLeft = 0;
                    
                    // Start timer
                    function startTimer() {
                        timerInterval = setInterval(() => {
                            if (secondsLeft === 0) {
                                if (minutesLeft === 0) {
                                    clearInterval(timerInterval);
                                    video.pause();
                                    vscode.postMessage({
                                        command: 'timerExpired'
                                    });
                                    return;
                                }
                                minutesLeft--;
                                secondsLeft = 59;
                            } else {
                                secondsLeft--;
                            }
                            
                            timeRemaining.textContent = \`\${minutesLeft}:\${secondsLeft < 10 ? '0' : ''}\${secondsLeft}\`;
                        }, 1000);
                    }
                    
                    startTimer();
                    
                    // Toggle play/pause
                    toggleButton.addEventListener('click', () => {
                        if (video.paused) {
                            video.play();
                            toggleButton.textContent = 'Pause';
                        } else {
                            video.pause();
                            toggleButton.textContent = 'Play';
                        }
                    });
                    
                    // Navigation
                    nextButton.addEventListener('click', () => {
                        vscode.postMessage({
                            command: 'next'
                        });
                    });
                    
                    prevButton.addEventListener('click', () => {
                        vscode.postMessage({
                            command: 'previous'
                        });
                    });
                    
                    // Custom feed
                    customFeedButton.addEventListener('click', () => {
                        vscode.postMessage({
                            command: 'customFeed'
                        });
                    });
                    
                    // Set timer
                    timerButton.addEventListener('click', () => {
                        vscode.postMessage({
                            command: 'setTimer'
                        });
                    });
                    
                    // Handle messages from extension
                    window.addEventListener('message', event => {
                        const message = event.data;
                        
                        switch (message.command) {
                            case 'togglePlay':
                                if (video.paused) {
                                    video.play();
                                    toggleButton.textContent = 'Pause';
                                } else {
                                    video.pause();
                                    toggleButton.textContent = 'Play';
                                }
                                break;
                        }
                    });
                    
                    // Keyboard shortcuts
                    document.addEventListener('keydown', (e) => {
                        if (e.ctrlKey && e.shiftKey) {
                            if (e.key === 'ArrowRight') {
                                vscode.postMessage({
                                    command: 'next'
                                });
                            } else if (e.key === 'ArrowLeft') {
                                vscode.postMessage({
                                    command: 'previous'
                                });
                            } else if (e.key === ' ') {
                                if (video.paused) {
                                    video.play();
                                    toggleButton.textContent = 'Pause';
                                } else {
                                    video.pause();
                                    toggleButton.textContent = 'Play';
                                }
                            }
                        }
                    });
                </script>
            </body>
            </html>
        `;
    }
}

// Exit point when extension is deactivated
export function deactivate() {
    // Dispose of the ReelsPanel if it exists
    if (ReelsPanel.currentPanel) {
        ReelsPanel.currentPanel.dispose();
    }
    
    // Clear any global state or variables if needed
    console.log('Instagram Reels extension has been deactivated');
}
