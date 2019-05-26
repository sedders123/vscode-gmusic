'use strict';
import { window, commands, Disposable, ExtensionContext, StatusBarAlignment, StatusBarItem } from 'vscode';
import * as WebSocket from 'ws';
import { IKeyedCollection, KeyedCollection } from "./utils"

export function activate(context: ExtensionContext) {
    let gMusic = new gMusicClass(context);

    let playpauseCommand = commands.registerCommand('gmusic.playpause', () => {
        gMusic.togglePlay();
    });
    let shuffleCommand = commands.registerCommand('gmusic.shuffle', () => {
        gMusic.toggleShuffle();
    });
    let skipCommand = commands.registerCommand('gmusic.skip', () => {
        gMusic.forward();
    });
    let rewindCommand = commands.registerCommand('gmusic.rewind', () => {
        gMusic.rewind();
    });
    let likeCommand = commands.registerCommand('gmusic.setThumbs', () => {
        window.showQuickPick(['Thumbs Up', 'Thumbs Down', 'Remove Rating'])
            .then(val => {
                switch (val) {
                    case 'Thumbs Up':
                        gMusic.thumbsUp();
                        break;
                    case 'Thumbs Down':
                        gMusic.thumbsDown();
                        break;
                    case 'Remove Rating':
                        gMusic.removeThumbs();
                        break;
                }
            }
            );
    });
    let restartCommand = commands.registerCommand('gmusic.restart', () => {
        gMusic.dispose();
        gMusic = new gMusicClass(context);
    })

    let cycleRepeatCommand = commands.registerCommand('gmusic.cycleRepeat', () => {
        gMusic.cycleRepeat();
    })

    context.subscriptions.push(playpauseCommand);
    context.subscriptions.push(shuffleCommand);
    context.subscriptions.push(skipCommand);
    context.subscriptions.push(rewindCommand);
    context.subscriptions.push(likeCommand);
    context.subscriptions.push(restartCommand)
    context.subscriptions.push(cycleRepeatCommand)
    context.subscriptions.push(gMusic);
}

interface Track {
    title: string;
    artist: string;
    album: string;
    albumArt: string;
}

interface gMusicResponse {
    channel: string;
    payload: any;
}

interface Rating {
    liked: boolean;
    disliked: boolean;
}

enum RepeatMode {
    None = "NO_REPEAT",
    Playlist = "LIST_REPEAT",
    Song = "SINGLE_REPEAT"
}

interface Button {
    id: string;
    title: string;
    command: string;
    text: string;
    dynamicText?: (cond: boolean) => string;
    statusBarItem: StatusBarItem;
    isVisible: boolean;
}

/**
 * Constantly changing class that holds GPMDP data
 *
 * @export
 * @class gMusicData
 */
export class gMusicClass implements Disposable {
    private _nowPlayingStatusBarItem: StatusBarItem;
    private _repeatStatusBarItem: StatusBarItem;
    private _buttons: IKeyedCollection<Button> = new KeyedCollection<Button>();

    private _playState: boolean;
    private _track: Track;
    private _rating: Rating;
    private _shuffle: string;
    private _repeat: RepeatMode;
    private ws: WebSocket;

    constructor(context: ExtensionContext) {
        const Cache = require('vscode-cache');

        // Create as needed
        if (!this._nowPlayingStatusBarItem) {
            this._nowPlayingStatusBarItem = window.createStatusBarItem(StatusBarAlignment.Left);
        }
        if (this._buttons.Count() === 0) {
            this.createControlButtons();
        }

        this.ws = new WebSocket('ws://localhost:5672');
        let codeCache = new Cache(context);

        // Being "polite" and asking GPMDP if we can have control.
        this.ws.on('open', () => {
            if (codeCache.has('authCode')) {
                this.ws.send(JSON.stringify({
                    namespace: 'connect',
                    method: 'connect',
                    arguments: ['vscode-gmusic', codeCache.get('authCode')]
                }))
            } else {
                this.ws.send(JSON.stringify({
                    namespace: 'connect',
                    method: 'connect',
                    arguments: ['vscode-gmusic']
                }))
            }
        })

        // Receiving data from GPMDP.
        this.ws.on('message', (data) => {
            let gMusicResponse: gMusicResponse = JSON.parse(data.toString());
            switch (gMusicResponse.channel) {
                case 'connect':
                    if (gMusicResponse.payload === 'CODE_REQUIRED') {
                        window.showInputBox({ prompt: 'Please input the number shown on GPMDP' }).then(code => {
                            this.ws.send(JSON.stringify({
                                namespace: 'connect',
                                method: 'connect',
                                arguments: ['vscode-gmusic', code]
                            }))
                        })
                    } else {
                        codeCache.put('authCode', gMusicResponse.payload)
                    }
                    break;
                case 'playState':
                    this._playState = gMusicResponse.payload;
                    this.refreshNowPlaying();
                    this.updateDynamicButton('playpause', this._playState);
                    break;
                case 'track':
                    this._track = gMusicResponse.payload;
                    this.refreshNowPlaying();
                    break;
                case 'rating':
                    this._rating = gMusicResponse.payload;
                    break;
                case 'shuffle':
                    this._shuffle = gMusicResponse.payload;
                    break;
                case 'repeat':
                    this._repeat = gMusicResponse.payload;
                    this.updateRepeatButtonState();
                    break;
            }
        });

        this.ws.on('error', (err) => window.showErrorMessage(`GMusic: WebSocket failed to connect`));
    }

    private createControlButtons() {
        const buttons = [
            { id: "rewind", title: "Previous Song", text: "$(chevron-left)" },
            { id: "playpause", title: "Play / Pause", text: '$(triangle-right)', dynamicText: (currentlyPlaying: boolean) => currentlyPlaying ? '$(primitive-square)' : '$(triangle-right)' },
            { id: "skip", title: "Next Song", text: "$(chevron-right)" }
        ];

        buttons.map(button => {
            const command = "gmusic." + button.id;
            const isVisible = true;
            var statusBarItem = window.createStatusBarItem(StatusBarAlignment.Left);
            statusBarItem.text = button.text;
            statusBarItem.command = command;
            statusBarItem.tooltip = button.title;
            this._buttons.Add(button.id, Object.assign({}, button, { command, statusBarItem, isVisible }));
            if (isVisible) statusBarItem.show();
        });

        this._repeatStatusBarItem = window.createStatusBarItem(StatusBarAlignment.Left);
        this._repeatStatusBarItem.command = "gmusic.cycleRepeat"
        this.updateRepeatButtonState();
        this._repeatStatusBarItem.show()
    }

    private updateRepeatButtonState() {
        switch (this._repeat) {
            case RepeatMode.None:
                this._repeatStatusBarItem.text = "$(sync)";
                this._repeatStatusBarItem.color = "darkGrey";
                this._repeatStatusBarItem.tooltip = "Not Repeating";
                break;
            case RepeatMode.Playlist:
                this._repeatStatusBarItem.text = "$(sync)";
                this._repeatStatusBarItem.color = "white";
                this._repeatStatusBarItem.tooltip = "Repeating Playlist";
                break;
            case RepeatMode.Song:
                this._repeatStatusBarItem.text = "$(issue-reopened)"
                this._repeatStatusBarItem.color = "white";
                this._repeatStatusBarItem.tooltip = "Repeating Song";
                break;
        }
    }

    private updateDynamicButton(id: string, condition: boolean) {
        const button = this._buttons.Item(id);
        const text = button.dynamicText(condition);
        button.statusBarItem.text = text;
    }

    public refreshNowPlaying() {
        let textItem = this.getNowPlayingText(this._track)
        if (textItem == null) {
            this._nowPlayingStatusBarItem.hide()
        }
        this._nowPlayingStatusBarItem.text = textItem
        this._nowPlayingStatusBarItem.show();
    }

    private getNowPlayingText(track: Track): string {
        if (track == null || track.title === null) {
            return null;
        }
        return `${track.title} - ${track.artist}`
    }

    public togglePlay() {
        this.ws.send(JSON.stringify({
            namespace: 'playback',
            method: 'playPause',
            arguments: null
        }))
    }

    public forward() {
        this.ws.send(JSON.stringify({
            namespace: 'playback',
            method: 'forward',
            arguments: null
        }))
    }

    public rewind() {
        this.ws.send(JSON.stringify({
            namespace: 'playback',
            method: 'rewind',
            arguments: null
        }))
    }

    public toggleShuffle() {
        this.ws.send(JSON.stringify({
            namespace: 'playback',
            method: 'toggleShuffle',
            arguments: null
        }))
    }

    public cycleRepeat() {
        switch (this._repeat) {
            case RepeatMode.None:
                this.toggleRepeat(RepeatMode.Playlist);
                break;
            case RepeatMode.Playlist:
                this.toggleRepeat(RepeatMode.Song);
                break;
            case RepeatMode.Song:
                this.toggleRepeat(RepeatMode.None);
                break;
        }
    }

    public toggleRepeat(mode: string) {
        this.ws.send(JSON.stringify({
            namespace: 'playback',
            method: 'setRepeat',
            arguments: [mode]
        }))
    }

    public thumbsUp() {
        if (!this._rating.liked) {
            this.ws.send(JSON.stringify({
                namespace: 'rating',
                method: 'toggleThumbsUp',
                arguments: null
            }))
        }
    }

    public thumbsDown() {
        if (!this._rating.disliked) {
            this.ws.send(JSON.stringify({
                namespace: 'rating',
                method: 'toggleThumbsDown',
                arguments: null
            }))
        }
    }

    public removeThumbs() {
        this.ws.send(JSON.stringify({
            namespace: 'rating',
            method: 'resetRating',
            arguments: null
        }))
    }

    public dispose() {
        this._nowPlayingStatusBarItem.dispose();
        this._buttons.Values().forEach(button => {
            button.statusBarItem.dispose();
        });
        this._repeatStatusBarItem.dispose();
        this.ws.close();
        process.nextTick(() => {
            if ([this.ws.OPEN, this.ws.CLOSING].includes(this.ws.readyState)) {
                // Socket still hangs, hard close
                this.ws.terminate();
            }
        });
    }
}
