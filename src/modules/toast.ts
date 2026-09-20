export function showToast(message: string, type: 'success' | 'error' | 'warning' = 'error', durationMs: number = 5000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300); // Wait for CSS fade transition
    }, durationMs);
}