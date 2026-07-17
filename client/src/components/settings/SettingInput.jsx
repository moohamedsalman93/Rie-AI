import { useState } from 'react';
import { Pencil } from 'lucide-react';
import { getSettings } from '../../services/chatApi';

export function SettingInput({ label, dbKey, value, onSave, isSaving, placeholder, isSecret, type = "text", allowEmpty = false }) {
  const [inputValue, setInputValue] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const isConfigured = !!value;

  const handleEditClick = async () => {
    // If it's a secret and we're currently seeing a masked value, fetch the real one
    if (isSecret && value && value.includes('****')) {
      try {
        const unmaskedSettings = await getSettings(true);
        // dbKey is e.g. "GOOGLE_API_KEY", response has "google_api_key"
        const apiKeyField = dbKey.toLowerCase();
        setInputValue(unmaskedSettings[apiKeyField] || '');
      } catch (err) {
        console.error("Failed to fetch unmasked key:", err);
        setInputValue('');
      }
    } else {
      setInputValue(value || '');
    }
    setIsEditing(true);
  };

  const handleSaveClick = async () => {
    if (!allowEmpty && !inputValue.trim()) return;
    await onSave(dbKey, inputValue);
    setIsEditing(false);
    setInputValue('');
  };

  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4  border-white/5 last:border-0">
      <div className="flex items-center gap-2.5 shrink-0">
        <label className="text-xs font-medium text-neutral-400 tracking-wider">{label}</label>
        {isConfigured && !isEditing && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
            Set
          </span>
        )}
      </div>

      <div className="flex-1 max-w-xs w-full sm:w-auto">
        {isEditing ? (
          <div className="flex flex-col gap-2">
            {type === "textarea" ? (
              <textarea
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                placeholder={placeholder}
                className="w-full bg-neutral-900 border border-neutral-600 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500/50 placeholder:text-neutral-600 min-h-[80px] font-mono"
                autoFocus
              />
            ) : (
              <input
                type={(isSecret && !inputValue) ? "password" : "text"} // Mask while typing if it's secret but show if revealed
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                placeholder={placeholder}
                className="w-full bg-neutral-900 border border-neutral-600 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500/50 placeholder:text-neutral-600"
                autoFocus
              />
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={handleSaveClick}
                disabled={isSaving || (!allowEmpty && !inputValue.trim())}
                className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded-lg transition-colors disabled:opacity-50"
              >
                {isSaving ? "..." : "Save"}
              </button>
              <button
                onClick={() => setIsEditing(false)}
                className="px-3 py-1 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-xs font-medium rounded-lg transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2 group justify-end items-center">
            <div
              onClick={handleEditClick}
              className={`flex-1 text-end cursor-pointer bg-neutral-900/50 border border-neutral-700/50 rounded-lg px-3 py-2 text-sm text-neutral-300 font-mono hover:border-neutral-600 transition-colors ${type === 'textarea' ? 'whitespace-pre-wrap' : 'truncate'} max-w-full`}
            >
              {value || <span className="text-neutral-600 italic">Not configured</span>}
            </div>
            <button
              onClick={handleEditClick}
              className="hidden group-hover:block px-2 text-neutral-400 hover:text-white"
            >
              <Pencil size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

