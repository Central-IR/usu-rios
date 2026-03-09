// CONFIGURAÇÃO
const PORTAL_URL = 'https://ir-comercio-portal-zcan.onrender.com';
const API_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:3004/api'
    : `${window.location.origin}/api`;

let usuarios = [];
let editingId = null;
let isOnline = false;
let sessionToken = null;
let consecutive401Count = 0;
const MAX_401_BEFORE_LOGOUT = 3;
let lastDataHash = '';
let deleteId = null;

// Controle de abas
const tabs = ['tab-dados', 'tab-ips'];
let currentTab = 0;

const viewTabs = ['view-tab-dados', 'view-tab-ips'];
let currentViewTab = 0;

// Utilitários
function toUpperCase(value) {
    return value ? String(value).toUpperCase() : '';
}

// NÃO usaremos mais uppercase automático nos inputs
// function setupUpperCaseInputs() { ... }  <-- removido

// Autenticação
document.addEventListener('DOMContentLoaded', () => {
    verificarAutenticacao();
});

function verificarAutenticacao() {
    const urlParams = new URLSearchParams(window.location.search);
    const tokenFromUrl = urlParams.get('sessionToken');

    if (tokenFromUrl) {
        sessionToken = tokenFromUrl;
        sessionStorage.setItem('usuariosSession', tokenFromUrl);
        window.history.replaceState({}, document.title, window.location.pathname);
    } else {
        sessionToken = sessionStorage.getItem('usuariosSession');
    }

    if (!sessionToken) {
        mostrarTelaAcessoNegado();
        return;
    }

    inicializarApp();
}

function mostrarTelaAcessoNegado(mensagem = 'NÃO AUTORIZADO') {
    document.body.innerHTML = `
        <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background: var(--bg-primary); color: var(--text-primary); text-align: center; padding: 2rem;">
            <h1 style="font-size: 2.2rem; margin-bottom: 1rem;">${mensagem}</h1>
            <p style="color: var(--text-secondary); margin-bottom: 2rem;">Somente usuários autenticados podem acessar esta área.</p>
            <a href="${PORTAL_URL}" style="display: inline-block; background: var(--btn-register); color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600;">Ir para o Portal</a>
        </div>
    `;
}

function inicializarApp() {
    updateDisplay();
    checkServerStatus();
    setInterval(checkServerStatus, 15000);
    startPolling();
}

async function checkServerStatus() {
    try {
        const headers = { 'Accept': 'application/json' };
        if (sessionToken) headers['X-Session-Token'] = sessionToken;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const response = await fetch(`${API_URL}/usuarios`, {
            method: 'HEAD',
            headers: headers,
            mode: 'cors',
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (response.status === 401) {
            consecutive401Count++;
            if (consecutive401Count >= MAX_401_BEFORE_LOGOUT) {
                sessionStorage.removeItem('usuariosSession');
                mostrarTelaAcessoNegado('Sua sessão expirou');
            }
            return false;
        }
        consecutive401Count = 0;

        const wasOffline = !isOnline;
        isOnline = response.ok;

        if (wasOffline && isOnline) {
            console.log('✅ SERVIDOR ONLINE');
            await loadUsuarios();
        }

        updateConnectionStatus();
        return isOnline;
    } catch (error) {
        isOnline = false;
        updateConnectionStatus();
        return false;
    }
}

function updateConnectionStatus() {
    const statusElement = document.getElementById('connectionStatus');
    if (statusElement) {
        statusElement.className = isOnline ? 'connection-status online' : 'connection-status offline';
    }
}

function startPolling() {
    loadUsuarios();
    setInterval(() => {
        if (isOnline) loadUsuarios();
    }, 10000);
}

async function loadUsuarios() {
    if (!isOnline) return;

    try {
        const headers = { 'Accept': 'application/json' };
        if (sessionToken) headers['X-Session-Token'] = sessionToken;

        const response = await fetch(`${API_URL}/usuarios`, {
            method: 'GET',
            headers: headers,
            mode: 'cors'
        });

        if (response.status === 401) {
            sessionStorage.removeItem('usuariosSession');
            mostrarTelaAcessoNegado('Sua sessão expirou');
            return;
        }

        if (!response.ok) return;

        const data = await response.json();
        usuarios = data.data || [];

        const newHash = JSON.stringify(usuarios.map(u => u.id));
        if (newHash !== lastDataHash) {
            lastDataHash = newHash;
            updateDisplay();
        }
    } catch (error) {
        console.error('❌ Erro ao carregar:', error);
    }
}

function updateDisplay() {
    filterUsuarios();
}

function filterUsuarios() {
    const search = toUpperCase(document.getElementById('search').value);
    const filtered = usuarios.filter(u => {
        return !search ||
            toUpperCase(u.name).includes(search) ||
            toUpperCase(u.username).includes(search) ||
            toUpperCase(u.sector || '').includes(search);
    });
    displayUsuarios(filtered);
}

function displayUsuarios(usuariosToDisplay) {
    const container = document.getElementById('usuariosContainer');
    if (usuariosToDisplay.length === 0) {
        container.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 2rem; color: var(--text-secondary);">Nenhum usuário encontrado</td></tr>';
        return;
    }

    container.innerHTML = usuariosToDisplay.map(u => `
        <tr>
            <td><strong>${u.name || '-'}</strong></td>
            <td>${u.username}</td>
            <td>${u.sector || '-'}</td>
            <td>${u.is_admin ? '✅' : '❌'}</td>
            <td>${u.is_active ? '✅' : '❌'}</td>
            <td>${(u.authorized_ips || []).length} IP(s)</td>
            <td class="actions-cell">
                <button class="action-btn view" onclick="viewUsuario('${u.id}')" title="Visualizar">Ver</button>
                <button class="action-btn edit" onclick="editUsuario('${u.id}')" title="Editar">Editar</button>
                <button class="action-btn delete" onclick="openDeleteModal('${u.id}')" title="Excluir">Excluir</button>
            </td>
        </tr>
    `).join('');
}

// Formatação de IPs (array para string)
function ipsArrayToString(ips) {
    return Array.isArray(ips) ? ips.join('\n') : '';
}

function ipsStringToArray(str) {
    if (!str) return [];
    return str.split(/\n|,/).map(s => s.trim()).filter(s => s !== '');
}

// Abas do formulário
function switchTab(tabId) {
    tabs.forEach((tab, index) => {
        document.getElementById(tab).classList.remove('active');
        document.querySelectorAll('.tabs-nav .tab-btn')[index].classList.remove('active');
    });
    document.getElementById(tabId).classList.add('active');
    const tabIndex = tabs.indexOf(tabId);
    document.querySelectorAll('.tabs-nav .tab-btn')[tabIndex].classList.add('active');
    currentTab = tabIndex;
    updateNavigationButtons();
}

function nextTab() {
    if (currentTab < tabs.length - 1) {
        currentTab++;
        switchTab(tabs[currentTab]);
    }
}

function previousTab() {
    if (currentTab > 0) {
        currentTab--;
        switchTab(tabs[currentTab]);
    }
}

function updateNavigationButtons() {
    const btnPrevious = document.getElementById('btnPrevious');
    const btnNext = document.getElementById('btnNext');
    const btnSave = document.getElementById('btnSave');

    btnPrevious.style.display = currentTab === 0 ? 'none' : 'inline-block';
    if (currentTab === tabs.length - 1) {
        btnNext.style.display = 'none';
        btnSave.style.display = 'inline-block';
    } else {
        btnNext.style.display = 'inline-block';
        btnSave.style.display = 'none';
    }
}

// Abas de visualização
function switchViewTab(tabId) {
    viewTabs.forEach((tab, index) => {
        document.getElementById(tab).classList.remove('active');
        document.querySelectorAll('#viewModal .tabs-nav .tab-btn')[index].classList.remove('active');
    });
    document.getElementById(tabId).classList.add('active');
    const tabIndex = viewTabs.indexOf(tabId);
    document.querySelectorAll('#viewModal .tabs-nav .tab-btn')[tabIndex].classList.add('active');
    currentViewTab = tabIndex;
    updateViewNavigationButtons();
}

function nextViewTab() {
    if (currentViewTab < viewTabs.length - 1) {
        currentViewTab++;
        switchViewTab(viewTabs[currentViewTab]);
    }
}

function previousViewTab() {
    if (currentViewTab > 0) {
        currentViewTab--;
        switchViewTab(viewTabs[currentViewTab]);
    }
}

function updateViewNavigationButtons() {
    const btnPrev = document.getElementById('btnViewPrev');
    const btnNext = document.getElementById('btnViewNext');
    btnPrev.style.display = currentViewTab === 0 ? 'none' : 'inline-block';
    btnNext.style.display = currentViewTab === viewTabs.length - 1 ? 'none' : 'inline-block';
}

// Modal de formulário
function openFormModal() {
    editingId = null;
    document.getElementById('formTitle').textContent = 'Novo Usuário';
    document.getElementById('formModal').classList.add('show');
    resetForm();
    currentTab = 0;
    switchTab(tabs[0]);
    // Não chamamos setupUpperCaseInputs()
}

function closeFormModal() {
    document.getElementById('formModal').classList.remove('show');
    resetForm();
}

function resetForm() {
    document.getElementById('nome').value = '';
    document.getElementById('username').value = '';
    document.getElementById('password').value = '';
    document.getElementById('sector').value = '';
    document.getElementById('isAdmin').checked = false;
    document.getElementById('isActive').checked = true;
    document.getElementById('authorizedIps').value = '';
}

// Salvar usuário
async function salvarUsuario() {
    const nome = document.getElementById('nome').value.trim();
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    const sector = document.getElementById('sector').value || null;
    const is_admin = document.getElementById('isAdmin').checked;
    const is_active = document.getElementById('isActive').checked;
    const ipsStr = document.getElementById('authorizedIps').value;
    const authorized_ips = ipsStringToArray(ipsStr);

    if (!nome || !username) {
        showToast('Nome e usuário são obrigatórios', 'error');
        return;
    }
    if (!editingId && !password) {
        showToast('Senha é obrigatória para novos usuários', 'error');
        return;
    }

    const usuario = {
        name: nome,                      // <-- sem .toUpperCase()
        username: username.toLowerCase(), // mantém minúsculas
        sector: sector,
        is_admin,
        is_active,
        authorized_ips
    };
    if (password) usuario.password = password;

    if (!isOnline) {
        showToast('Sistema offline', 'error');
        closeFormModal();
        return;
    }

    try {
        const url = editingId ? `${API_URL}/usuarios/${editingId}` : `${API_URL}/usuarios`;
        const method = editingId ? 'PUT' : 'POST';
        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        };
        if (sessionToken) headers['X-Session-Token'] = sessionToken;

        const response = await fetch(url, {
            method,
            headers,
            body: JSON.stringify(usuario)
        });

        if (response.status === 401) {
            sessionStorage.removeItem('usuariosSession');
            mostrarTelaAcessoNegado('Sua sessão expirou');
            return;
        }

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || 'Erro ao salvar');
        }

        showToast('Usuário salvo com sucesso', 'success');
        closeFormModal();
        await loadUsuarios();
    } catch (error) {
        console.error('Erro:', error);
        showToast(`Erro: ${error.message}`, 'error');
    }
}

// Editar usuário
async function editUsuario(id) {
    editingId = id;
    const usuario = usuarios.find(u => u.id === id);
    if (!usuario) return;

    document.getElementById('formTitle').textContent = `Editar ${usuario.name}`;
    document.getElementById('nome').value = usuario.name;
    document.getElementById('username').value = usuario.username;
    document.getElementById('password').value = ''; // não preenche a senha
    document.getElementById('sector').value = usuario.sector || '';
    document.getElementById('isAdmin').checked = usuario.is_admin || false;
    document.getElementById('isActive').checked = usuario.is_active !== false;
    document.getElementById('authorizedIps').value = ipsArrayToString(usuario.authorized_ips || []);

    document.getElementById('formModal').classList.add('show');
    currentTab = 0;
    switchTab(tabs[0]);
    // Não chamamos setupUpperCaseInputs()
}

// Visualizar usuário
function viewUsuario(id) {
    const u = usuarios.find(u => u.id === id);
    if (!u) return;

    document.getElementById('viewNome').textContent = u.name;
    document.getElementById('viewUsername').textContent = u.username;
    document.getElementById('viewSector').textContent = u.sector || '-';
    document.getElementById('viewAdmin').textContent = u.is_admin ? 'Sim' : 'Não';
    document.getElementById('viewActive').textContent = u.is_active ? 'Sim' : 'Não';

    const ips = u.authorized_ips || [];
    const ipsHtml = ips.length ? ips.map(ip => `<div>${ip}</div>`).join('') : '<div>Nenhum IP cadastrado</div>';
    document.getElementById('viewIpsList').innerHTML = ipsHtml;

    document.getElementById('viewModal').classList.add('show');
    currentViewTab = 0;
    switchViewTab(viewTabs[0]);
}

function closeViewModal() {
    document.getElementById('viewModal').classList.remove('show');
}

// Exclusão
function openDeleteModal(id) {
    deleteId = id;
    document.getElementById('deleteModal').classList.add('show');
}

function closeDeleteModal() {
    deleteId = null;
    document.getElementById('deleteModal').classList.remove('show');
}

async function confirmarExclusao() {
    closeDeleteModal();
    if (!isOnline) {
        showToast('Sistema offline. Não foi possível excluir.', 'error');
        return;
    }

    try {
        const headers = { 'Accept': 'application/json' };
        if (sessionToken) headers['X-Session-Token'] = sessionToken;

        const response = await fetch(`${API_URL}/usuarios/${deleteId}`, {
            method: 'DELETE',
            headers
        });

        if (response.status === 401) {
            sessionStorage.removeItem('usuariosSession');
            mostrarTelaAcessoNegado('Sua sessão expirou');
            return;
        }

        if (!response.ok) throw new Error('Erro ao deletar');

        usuarios = usuarios.filter(u => u.id !== deleteId);
        lastDataHash = JSON.stringify(usuarios.map(u => u.id));
        updateDisplay();
        showToast('Usuário excluído', 'success');
    } catch (error) {
        console.error('Erro ao deletar:', error);
        showToast('Erro ao excluir usuário', 'error');
    }
}

// Toast
function showToast(message, type = 'success') {
    const oldMessages = document.querySelectorAll('.floating-message');
    oldMessages.forEach(msg => msg.remove());

    const messageDiv = document.createElement('div');
    messageDiv.className = `floating-message ${type}`;
    messageDiv.textContent = message;
    document.body.appendChild(messageDiv);

    setTimeout(() => {
        messageDiv.style.animation = 'slideOutBottom 0.3s ease forwards';
        setTimeout(() => messageDiv.remove(), 300);
    }, 3000);
}
