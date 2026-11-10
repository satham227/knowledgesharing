import { DecimalPipe } from '@angular/common';
import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild } from '@angular/core';
import { BoardObject, EventType, Point, RoomUser, WhiteboardEvent } from '../../shared/protocol';
import {
  ClientMetrics,
  ConnectionState,
  SimulationSettings,
  TransportMode,
  WhiteboardTransport,
} from './core/services/transport.service';

@Component({
  selector: 'app-root',
  imports: [DecimalPipe],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements AfterViewInit, OnDestroy {
  @ViewChild('board') private canvas?: ElementRef<HTMLCanvasElement>;
  roomId = `room-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
  name = `Guest ${Math.floor(Math.random() * 90 + 10)}`;
  mode: TransportMode = 'websocket';
  tool:
    | 'select'
    | 'pencil'
    | 'eraser'
    | 'rectangle'
    | 'circle'
    | 'line'
    | 'arrow'
    | 'sticky'
    | 'text' = 'pencil';
  color = '#d85a45';
  connectedUsers: RoomUser[] = [];
  objects: BoardObject[] = [];
  cursors: { userId: string; name: string; color: string; x: number; y: number }[] = [];
  status: ConnectionState = 'disconnected';
  detail = '';
  joined = false;
  grid = true;
  simulationOpen = false;
  metrics: ClientMetrics = {
    mode: 'websocket',
    establishmentMs: null,
    rttMs: null,
    messagesSent: 0,
    messagesReceived: 0,
    reliableMessagesSent: 0,
    reliableMessagesReceived: 0,
    datagramMessagesSent: 0,
    datagramMessagesReceived: 0,
    bytesSent: 0,
    bytesReceived: 0,
    messagesPerSecond: 0,
    droppedDatagrams: 0,
    reconnects: 0,
    serverProcessingMs: null,
    syncStatus: 'offline',
  };
  simulation: SimulationSettings = {
    enabled: false,
    delayMs: 0,
    cursorRate: 30,
    dropPercent: 0,
    slowBulk: false,
  };
  private transport?: WhiteboardTransport;
  private activeObject?: BoardObject;
  private draggedNote?: BoardObject;
  private pointerDown = false;
  userId = '';
  private resizeObserver?: ResizeObserver;
  private cursorSequence = 0;
  private readonly lastCursorSequences = new Map<string, number>();
  private readonly cursorsByUser = new Map<
    string,
    { userId: string; name: string; color: string; x: number; y: number }
  >();

  ngAfterViewInit(): void {
    if (!this.canvas) return;
    this.resizeObserver = new ResizeObserver(() => this.redraw());
    this.resizeObserver.observe(this.canvas.nativeElement);
    this.redraw();
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.transport?.close();
  }

  connect(): void {
    this.transport?.close();
    this.transport = new WhiteboardTransport(
      (event) => this.receive(event),
      (state, detail) => {
        this.status = state;
        this.detail = detail ?? '';
      },
      (metrics) => (this.metrics = metrics),
    );
    this.transport.setSimulation(this.simulation);
    this.transport.connect(this.mode, this.roomId, this.name);
    this.joined = true;
  }

  createRoom(): void {
    this.roomId = `room-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
    this.connect();
  }

  leave(): void {
    this.transport?.close();
    this.transport = undefined;
    this.joined = false;
    this.connectedUsers = [];
    this.userId = '';
  }

  setMode(mode: TransportMode): void {
    this.mode = mode;
    this.metrics.mode = mode;
    if (this.joined) this.connect();
  }
  setTool(tool: App['tool']): void {
    this.tool = tool;
  }
  setSimulationValue(key: keyof SimulationSettings, value: boolean | number): void {
    this.simulation = { ...this.simulation, [key]: value };
    this.transport?.setSimulation(this.simulation);
  }
  copyRoomId(): void {
    void navigator.clipboard?.writeText(this.roomId);
  }

  pointerDownOnBoard(event: PointerEvent): void {
    if (!this.joined || !this.canvas) return;
    const point = this.pointFrom(event);
    this.canvas.nativeElement.setPointerCapture(event.pointerId);
    this.pointerDown = true;
    if (this.tool === 'eraser') {
      const target = this.objectNear(point);
      if (target) {
        this.objects = this.objects.filter((object) => object.id !== target.id);
        this.send('OBJECT_DELETED', { objectId: target.id });
        this.redraw();
      }
      this.pointerDown = false;
      return;
    }
    if (this.tool === 'select') {
      this.draggedNote = this.objectAt(point);
      return;
    }
    if (this.tool === 'sticky' || this.tool === 'text') {
      const object: BoardObject = {
        id: crypto.randomUUID(),
        kind: this.tool,
        x: point.x,
        y: point.y,
        width: 0.2,
        height: 0.15,
        color: this.tool === 'sticky' ? '#f2ce76' : this.color,
        text: this.tool === 'sticky' ? 'Double-click to edit' : 'Text',
        userId: this.userId,
      };
      this.objects.push(object);
      this.commit(object, this.tool === 'sticky' ? 'STICKY_NOTE_CREATED' : 'SHAPE_CREATED');
      this.redraw();
      this.pointerDown = false;
      return;
    }
    const kind = this.tool === 'pencil' ? 'stroke' : this.tool;
    this.activeObject = {
      id: crypto.randomUUID(),
      kind,
      points: [point],
      x: point.x,
      y: point.y,
      width: 0,
      height: 0,
      color: this.color,
      userId: this.userId,
    };
    this.send('DRAW_START', { object: this.activeObject });
    this.redraw();
  }

  pointerMoveOnBoard(event: PointerEvent): void {
    const point = this.pointFrom(event);
    this.send('CURSOR_MOVE', { x: point.x, y: point.y, cursorSequence: ++this.cursorSequence });
    if (this.draggedNote && this.pointerDown) {
      this.draggedNote.x = point.x - (this.draggedNote.width ?? 0) / 2;
      this.draggedNote.y = point.y - (this.draggedNote.height ?? 0) / 2;
      this.redraw();
    } else if (this.activeObject && this.pointerDown) {
      const start = this.activeObject.points?.[0] ?? {
        x: this.activeObject.x,
        y: this.activeObject.y,
      };
      if (this.activeObject.kind === 'stroke') this.activeObject.points?.push(point);
      else {
        this.activeObject.width = point.x - start.x;
        this.activeObject.height = point.y - start.y;
        this.activeObject.points = [start, point];
      }
      this.send('DRAW_MOVE', { object: this.activeObject });
      this.redraw();
    }
  }

  pointerUpOnBoard(): void {
    if (this.activeObject) {
      this.objects.push(this.activeObject);
      this.commit(this.activeObject, 'DRAW_END');
      this.activeObject = undefined;
    }
    if (this.draggedNote) {
      this.commit(this.draggedNote, 'STICKY_NOTE_UPDATED');
      this.draggedNote = undefined;
    }
    this.pointerDown = false;
    this.redraw();
  }

  editStickyAt(event: MouseEvent): void {
    const object = this.objectAt(this.pointFrom(event as unknown as PointerEvent));
    if (!object || (object.kind !== 'sticky' && object.kind !== 'text')) return;
    const text = prompt(object.kind === 'sticky' ? 'Sticky note' : 'Text', object.text ?? '');
    if (text !== null) {
      object.text = text.slice(0, 280);
      this.commit(object, 'STICKY_NOTE_UPDATED');
      this.redraw();
    }
  }

  clearBoard(): void {
    if (!this.objects.length) return;
    this.objects = [];
    this.send('BOARD_CLEARED', {});
    this.redraw();
  }
  undo(): void {
    if (this.objects.length) this.send('UNDO', {});
  }
  redo(): void {
    this.send('REDO', {});
  }

  private receive(event: WhiteboardEvent): void {
    if (event.eventType === 'BOARD_SNAPSHOT') {
      const snapshot = event.payload as unknown as {
        objects: BoardObject[];
        users: RoomUser[];
        selfUserId: string;
      };
      this.userId = snapshot.selfUserId;
      this.objects = snapshot.objects ?? [];
      this.connectedUsers = snapshot.users ?? [];
      this.color = snapshot.users?.find((user) => user.id === this.userId)?.color ?? this.color;
      this.cursorsByUser.clear();
      this.cursors = [];
      this.lastCursorSequences.clear();
      this.redraw();
      return;
    }
    if (event.eventType === 'USER_JOINED') {
      const user = (event.payload as { user: RoomUser }).user;
      if (user && !this.connectedUsers.some((entry) => entry.id === user.id))
        this.connectedUsers = [...this.connectedUsers, user];
    } else if (event.eventType === 'USER_LEFT') {
      const id = String((event.payload as { userId: string }).userId);
      this.connectedUsers = this.connectedUsers.filter((user) => user.id !== id);
      this.cursorsByUser.delete(id);
      this.lastCursorSequences.delete(id);
      this.cursors = [...this.cursorsByUser.values()];
    } else if (event.eventType === 'CURSOR_MOVE') {
      const payload = event.payload as { x: number; y: number; cursorSequence: number };
      const previous = this.lastCursorSequences.get(event.userId) ?? -1;
      if (payload.cursorSequence <= previous) return;
      this.lastCursorSequences.set(event.userId, payload.cursorSequence);
      const user = this.connectedUsers.find((entry) => entry.id === event.userId);
      if (user) {
        this.cursorsByUser.set(user.id, {
          userId: user.id,
          name: user.name,
          color: user.color,
          x: payload.x,
          y: payload.y,
        });
        this.cursors = [...this.cursorsByUser.values()];
      }
    } else if (event.eventType === 'DRAW_START' || event.eventType === 'DRAW_MOVE') {
      const object = (event.payload as { object: BoardObject }).object;
      if (object && event.userId !== this.userId) this.upsertObject(object);
    } else if (
      event.eventType === 'DRAW_END' ||
      event.eventType === 'SHAPE_CREATED' ||
      event.eventType === 'STICKY_NOTE_CREATED' ||
      event.eventType === 'STICKY_NOTE_UPDATED'
    ) {
      const object = (event.payload as { object: BoardObject }).object;
      if (object) this.upsertObject(object);
    } else if (event.eventType === 'BOARD_CLEARED') this.objects = [];
    else if (event.eventType === 'OBJECT_DELETED') {
      const id = String((event.payload as { objectId: string }).objectId);
      this.objects = this.objects.filter((object) => object.id !== id);
    } else if (event.eventType === 'UNDO') this.objects.pop();
    else if (event.eventType === 'REDO') {
      const object = (event.payload as { object?: BoardObject }).object;
      if (object) this.upsertObject(object);
    }
    this.redraw();
  }

  private upsertObject(object: BoardObject): void {
    const index = this.objects.findIndex((entry) => entry.id === object.id);
    if (index >= 0) this.objects[index] = object;
    else this.objects.push(object);
  }
  private commit(object: BoardObject, type: EventType): void {
    this.send(type, { object });
  }
  private send(type: EventType, payload: Record<string, unknown>): void {
    this.transport?.sendEvent(type, payload);
  }
  private pointFrom(event: PointerEvent): Point {
    const rect = this.canvas!.nativeElement.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  }
  private objectAt(point: Point): BoardObject | undefined {
    return [...this.objects]
      .reverse()
      .find(
        (object) =>
          object.kind === 'sticky' &&
          point.x >= object.x &&
          point.x <= object.x + (object.width ?? 0) &&
          point.y >= object.y &&
          point.y <= object.y + (object.height ?? 0),
      );
  }
  private objectNear(point: Point): BoardObject | undefined {
    const note = this.objectAt(point);
    if (note) return note;
    return [...this.objects]
      .reverse()
      .find((object) =>
        object.points?.some(
          (candidate) =>
            Math.abs(candidate.x - point.x) < 0.02 && Math.abs(candidate.y - point.y) < 0.03,
        ),
      );
  }

  redraw(): void {
    const canvas = this.canvas?.nativeElement;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.fillStyle = '#fff';
    context.fillRect(0, 0, rect.width, rect.height);
    if (this.grid) {
      context.strokeStyle = '#edf0ed';
      context.lineWidth = 1;
      for (let x = 24; x < rect.width; x += 24) {
        context.beginPath();
        context.moveTo(x, 0);
        context.lineTo(x, rect.height);
        context.stroke();
      }
      for (let y = 24; y < rect.height; y += 24) {
        context.beginPath();
        context.moveTo(0, y);
        context.lineTo(rect.width, y);
        context.stroke();
      }
    }
    for (const object of this.objects) this.drawObject(context, object, rect.width, rect.height);
    if (this.activeObject) this.drawObject(context, this.activeObject, rect.width, rect.height);
  }

  private drawObject(
    context: CanvasRenderingContext2D,
    object: BoardObject,
    width: number,
    height: number,
  ): void {
    const x = object.x * width;
    const y = object.y * height;
    const w = (object.width ?? 0) * width;
    const h = (object.height ?? 0) * height;
    context.save();
    context.strokeStyle = object.color;
    context.fillStyle = object.color;
    context.lineWidth = 3;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    if (object.kind === 'sticky') {
      context.fillRect(x, y, w, h);
      context.fillStyle = '#514528';
      context.font = '13px Trebuchet MS';
      const words = (object.text ?? '').split(' ');
      let line = '';
      let lineY = y + 23;
      for (const word of words) {
        const next = `${line}${word} `;
        if (context.measureText(next).width > w - 20) {
          context.fillText(line, x + 10, lineY);
          line = `${word} `;
          lineY += 17;
        } else line = next;
      }
      context.fillText(line, x + 10, lineY);
    } else if (object.kind === 'text') {
      context.font = '18px Trebuchet MS';
      context.fillText(object.text ?? '', x, y + 18);
    } else if (object.kind === 'rectangle') context.strokeRect(x, y, w, h);
    else if (object.kind === 'circle') {
      context.beginPath();
      context.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
      context.stroke();
    } else if (object.kind === 'stroke' || object.kind === 'line' || object.kind === 'arrow') {
      const points = object.points ?? [{ x: object.x, y: object.y }];
      context.beginPath();
      context.moveTo(points[0]!.x * width, points[0]!.y * height);
      for (const point of points.slice(1)) context.lineTo(point.x * width, point.y * height);
      context.stroke();
      if (object.kind === 'arrow' && points.length > 1) {
        const from = points[points.length - 2]!;
        const to = points[points.length - 1]!;
        const angle = Math.atan2((to.y - from.y) * height, (to.x - from.x) * width);
        const size = 10;
        context.beginPath();
        context.moveTo(to.x * width, to.y * height);
        context.lineTo(
          to.x * width - size * Math.cos(angle - 0.5),
          to.y * height - size * Math.sin(angle - 0.5),
        );
        context.moveTo(to.x * width, to.y * height);
        context.lineTo(
          to.x * width - size * Math.cos(angle + 0.5),
          to.y * height - size * Math.sin(angle + 0.5),
        );
        context.stroke();
      }
    }
    context.restore();
  }
}
