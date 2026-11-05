import { DataModel } from '../core/instance';

/** Snapshot-based undo/redo. Each entry is a full clone of the place. */
export class History {
  private undoStack: DataModel[] = [];
  private redoStack: DataModel[] = [];
  constructor(private limit = 60) {}
  reset(model: DataModel) { this.undoStack = [model.cloneModel()]; this.redoStack = []; }
  commit(model: DataModel) {
    this.undoStack.push(model.cloneModel());
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }
  canUndo() { return this.undoStack.length > 1; }
  canRedo() { return this.redoStack.length > 0; }
  undo(): DataModel | null {
    if (!this.canUndo()) return null;
    this.redoStack.push(this.undoStack.pop()!);
    return this.undoStack[this.undoStack.length - 1].cloneModel();
  }
  redo(): DataModel | null {
    const m = this.redoStack.pop();
    if (!m) return null;
    this.undoStack.push(m);
    return m.cloneModel();
  }
}
