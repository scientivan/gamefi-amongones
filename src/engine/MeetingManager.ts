export interface ChatMessage {
  sender: string;
  content: string;
  timestamp: number;
}

export class MeetingManager {
  private chatLogs: ChatMessage[] = [];
  private votes: Record<string, string> = {}; // voterId -> targetId
  private isActive: boolean = false;

  constructor() {}

  public startMeeting() {
    this.isActive = true;
    this.chatLogs = [];
    this.votes = {};
  }

  public endMeeting() {
    this.isActive = false;
  }

  public addMessage(sender: string, content: string) {
    if (!this.isActive) return;
    this.chatLogs.push({
      sender,
      content,
      timestamp: Date.now(),
    });
  }

  public getLogs(): ChatMessage[] {
    return this.chatLogs;
  }

  public castVote(voter: string, target: string) {
    if (!this.isActive) return;
    this.votes[voter] = target;
  }

  public getVotes(): Record<string, string> {
    return this.votes;
  }

  public isMeetingActive(): boolean {
    return this.isActive;
  }
}
