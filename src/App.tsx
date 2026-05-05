import { useState } from 'react';
import './index.css';

// Type definitions for File System Access API
// (Not comprehensive, but enough for TS to compile)
interface FileSystemHandle {
  kind: 'file' | 'directory';
  name: string;
}

interface FileSystemFileHandle extends FileSystemHandle {
  kind: 'file';
  getFile(): Promise<File>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<FileSystemWritableFileStream>;
}

interface FileSystemDirectoryHandle extends FileSystemHandle {
  kind: 'directory';
  values(): AsyncIterableIterator<FileSystemHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

interface FileSystemWritableFileStream {
  write(data: File | BufferSource | Blob | string): Promise<void>;
  close(): Promise<void>;
}

// Unified file interface for both native API and Fallback API
interface AppFile {
  file: File;
  name: string;
  handle?: FileSystemFileHandle;
}

function App() {
  const [dirHandle, setDirHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [files, setFiles] = useState<AppFile[]>([]);
  const [activeFile, setActiveFile] = useState<AppFile | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  
  // Check browser support
  const isSupported = 'showDirectoryPicker' in window;

  const handleSelectFolderNative = async () => {
    try {
      setError(null);
      // @ts-ignore - TS doesn't have standard typings for this yet
      const handle: FileSystemDirectoryHandle = await window.showDirectoryPicker({
        mode: 'readwrite'
      });
      setDirHandle(handle);
      await loadFilesNative(handle);
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setError(err.message || 'Error accessing folder');
      }
    }
  };

  const loadFilesNative = async (handle: FileSystemDirectoryHandle) => {
    const pdfFiles: AppFile[] = [];
    try {
      // @ts-ignore
      for await (const entry of handle.values()) {
        if (entry.kind === 'file' && entry.name.toLowerCase().endsWith('.pdf')) {
          const fileHandle = entry as FileSystemFileHandle;
          const fileData = await fileHandle.getFile();
          pdfFiles.push({ file: fileData, name: fileData.name, handle: fileHandle });
        }
      }
      
      // Sort files alphabetically
      pdfFiles.sort((a, b) => a.name.localeCompare(b.name));
      
      setFiles(pdfFiles);
      
      // If we had an active file, try to find it in the new list, or clear if deleted
      if (activeFile && !pdfFiles.find(f => f.name === activeFile.name)) {
        clearActivePreview();
      } else if (!activeFile && pdfFiles.length > 0) {
        // Auto-select first file if none selected
        handleFileSelect(pdfFiles[0]);
      }
    } catch (err: any) {
      setError('Failed to load files: ' + err.message);
    }
  };

  const handleFallbackFolderSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    try {
      setError(null);
      const selectedFiles = Array.from(e.target.files || []);
      const pdfs: AppFile[] = selectedFiles
        .filter(f => f.name.toLowerCase().endsWith('.pdf'))
        .map(f => ({ file: f, name: f.name }));
        
      pdfs.sort((a, b) => a.name.localeCompare(b.name));
      
      setFiles(pdfs);
      
      if (!activeFile && pdfs.length > 0) {
        handleFileSelect(pdfs[0]);
      }
      
      // Clear input value so if the user selects the same folder again it triggers
      e.target.value = '';
    } catch (err: any) {
      setError('Failed to parse selected folder: ' + err.message);
    }
  };

  const handleFileSelect = (appFile: AppFile) => {
    try {
      setActiveFile(appFile);
      
      // Clean up previous URL
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
      
      const newUrl = URL.createObjectURL(appFile.file);
      setPreviewUrl(newUrl);
      
      // Remove .pdf for the input field
      const nameWithoutExt = appFile.name.replace(/\.[^/.]+$/, "");
      setNewName(nameWithoutExt);
    } catch (err: any) {
      setError('Failed to display file: ' + err.message);
    }
  };

  const clearActivePreview = () => {
    setActiveFile(null);
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
    }
    setNewName('');
  };

  const handleRenameNative = async (newNameWithExt: string) => {
    if (!dirHandle || !activeFile || !activeFile.handle) return;
    
    try {
      // 1. Create a new file
      const newFileHandle = await dirHandle.getFileHandle(newNameWithExt, { create: true });
      
      // 2. Stream content from old file to new file
      const writable = await newFileHandle.createWritable();
      await writable.write(activeFile.file);
      await writable.close();
      
      // 3. Delete old file
      await dirHandle.removeEntry(activeFile.handle.name);
      
      // Auto-select the newly created file after a short delay
      const updatedFileHandle = await dirHandle.getFileHandle(newNameWithExt);
      const updatedFileData = await updatedFileHandle.getFile();
      
      await loadFilesNative(dirHandle);
      
      handleFileSelect({ file: updatedFileData, name: updatedFileData.name, handle: updatedFileHandle });
      
    } catch (err: any) {
      setError('Failed to rename file natively: ' + err.message);
    }
  };

  const handleRenameFallback = (newNameWithExt: string) => {
    if (!activeFile) return;
    // Download the renamed file
    const url = URL.createObjectURL(activeFile.file);
    const a = document.createElement('a');
    a.href = url;
    a.download = newNameWithExt;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    setError('File downloaded. Note: Due to browser limitations, you will need to manually delete the old file.');
  };

  const handleRename = async () => {
    if (!activeFile || !newName.trim()) return;
    
    const newNameWithExt = `${newName.trim()}.pdf`;
    
    // Check if name hasn't changed
    if (newNameWithExt === activeFile.name) {
      return;
    }
    
    // Check if new name already exists
    if (files.some(f => f.name.toLowerCase() === newNameWithExt.toLowerCase())) {
      setError('A file with this name already exists in the folder list.');
      return;
    }
    
    setIsRenaming(true);
    setError(null);
    
    try {
      if (isSupported && activeFile.handle && dirHandle) {
        await handleRenameNative(newNameWithExt);
      } else {
        handleRenameFallback(newNameWithExt);
      }
    } finally {
      setIsRenaming(false);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatDate = (ms: number) => {
    return new Date(ms).toLocaleString();
  };

  return (
    <div className="app-container">
      {/* Left Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1>PDF Manager</h1>
          {isSupported ? (
            <button className="button-primary" onClick={handleSelectFolderNative}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
              </svg>
              Select Folder
            </button>
          ) : (
            <label className="button-primary" style={{ cursor: 'pointer' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
              </svg>
              Select Folder
              {/* @ts-ignore non-standard folder attributes are sometimes not in react types */}
              <input type="file" webkitdirectory="" directory="" multiple onChange={handleFallbackFolderSelect} style={{ display: 'none' }} />
            </label>
          )}
        </div>
        
        <div className="file-list">
          {files.length === 0 && (
            <div className="empty-state">
              <p>No PDFs currently loaded.</p>
            </div>
          )}
          
          {files.map(appFile => (
            <div 
              key={appFile.name} 
              className={`file-item ${activeFile?.name === appFile.name ? 'active' : ''}`}
              onClick={() => handleFileSelect(appFile)}
              title={appFile.name}
            >
              📄 {appFile.name}
            </div>
          ))}
        </div>
      </aside>

      {/* Center Preview */}
      <main className="preview-panel">
        {!isSupported && files.length > 0 && !error && (
            <div style={{ backgroundColor: 'rgba(59, 130, 246, 0.1)', color: 'var(--accent-color)', padding: '12px 24px', borderBottom: '1px solid rgba(59, 130, 246, 0.2)' }}>
              ℹ️ Using limited browser fallback. "Saving" a name will download the renamed PDF. For full native file renaming, use Chrome/Edge.
            </div>
        )}
        {error && (
          <div style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)', color: 'var(--danger-color)', padding: '12px 24px', borderBottom: '1px solid rgba(239, 68, 68, 0.2)' }}>
            ⚠️ {error}
          </div>
        )}
        
        {previewUrl ? (
          <div className="pdf-viewer-container">
            <object 
              data={previewUrl} 
              type="application/pdf"
              style={{ width: '100%', height: '100%' }}
            >
              <div className="empty-state">
                <p>Unable to display PDF preview.</p>
              </div>
            </object>
          </div>
        ) : (
          <div className="empty-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}>
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
              <line x1="16" y1="13" x2="8" y2="13"></line>
              <line x1="16" y1="17" x2="8" y2="17"></line>
              <polyline points="10 9 9 9 8 9"></polyline>
            </svg>
            <p>Select a PDF from the sidebar to preview.</p>
          </div>
        )}
      </main>

      {/* Right Details */}
      <aside className="details-panel">
        <div className="details-header">
          <h2>File Details</h2>
        </div>
        
        {activeFile ? (
          <>
            <div className="input-container">
              <label className="input-label" htmlFor="rename-input">File Name</label>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <input 
                  id="rename-input"
                  type="text" 
                  className="input-field" 
                  value={newName} 
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRename();
                  }}
                  disabled={isRenaming}
                />
                <span style={{ marginLeft: '8px', color: 'var(--text-muted)' }}>.pdf</span>
              </div>
              <button 
                className="button-primary button-save" 
                onClick={handleRename}
                disabled={isRenaming || !newName.trim() || `${newName.trim()}.pdf` === activeFile.name}
              >
                {isRenaming ? 'Renaming...' : (isSupported && activeFile.handle ? 'Save Name' : 'Download Renamed')}
              </button>
            </div>
            
            <div className="metadata-grid">
              <div className="metadata-item">
                <span className="input-label">Size</span>
                <span className="metadata-value">{formatBytes(activeFile.file.size)}</span>
              </div>
              <div className="metadata-item">
                <span className="input-label">Date Modified</span>
                <span className="metadata-value">{formatDate(activeFile.file.lastModified)}</span>
              </div>
              <div className="metadata-item">
                <span className="input-label">Type</span>
                <span className="metadata-value">{activeFile.file.type || 'application/pdf'}</span>
              </div>
            </div>
          </>
        ) : (
          <div className="empty-state" style={{ height: 'auto', marginTop: '40px' }}>
            <p>No file selected</p>
          </div>
        )}
      </aside>
    </div>
  );
}

export default App;
