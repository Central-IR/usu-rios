require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3004; // Porta diferente da transportadora

// Configuração do Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ ERRO: Variáveis de ambiente do Supabase não configuradas');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Middlewares
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-Token', 'Accept'],
    credentials: true
}));
app.options('*', cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Registro de acessos (opcional, igual à transportadora)
const logFilePath = path.join(__dirname, 'acessos.log');
let accessCount = 0;
let uniqueIPs = new Set();

function registrarAcesso(req, res, next) {
    const xForwardedFor = req.headers['x-forwarded-for'];
    const clientIP = xForwardedFor
        ? xForwardedFor.split(',')[0].trim()
        : req.socket.remoteAddress;
    const cleanIP = clientIP.replace('::ffff:', '');
    const logEntry = `[${new Date().toISOString()}] ${cleanIP} - ${req.method} ${req.path}\n`;
    fs.appendFile(logFilePath, logEntry, () => {});
    accessCount++;
    uniqueIPs.add(cleanIP);
    next();
}
app.use(registrarAcesso);

// Relatório periódico
setInterval(() => {
    if (accessCount > 0) {
        console.log(`📊 Última hora: ${accessCount} requisições de ${uniqueIPs.size} IPs únicos`);
        accessCount = 0;
        uniqueIPs.clear();
    }
}, 3600000);

// Configuração do Portal (para verificar autenticação)
const PORTAL_URL = process.env.PORTAL_URL || 'https://ir-comercio-portal-zcan.onrender.com';

// Middleware de autenticação via token do Portal
async function verificarAutenticacao(req, res, next) {
    if (req.method === 'HEAD') return next();

    const publicPaths = ['/', '/health', '/app'];
    if (publicPaths.includes(req.path)) return next();

    const sessionToken = req.headers['x-session-token'] || req.query.sessionToken;
    if (!sessionToken) {
        return res.status(401).json({ error: 'Não autenticado', redirectToLogin: true });
    }

    try {
        const verifyResponse = await fetch(`${PORTAL_URL}/api/verify-session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionToken }),
            signal: AbortSignal.timeout(5000)
        });

        if (!verifyResponse.ok) {
            return res.status(401).json({ error: 'Sessão inválida', redirectToLogin: true });
        }

        const sessionData = await verifyResponse.json();
        if (!sessionData.valid) {
            return res.status(401).json({ error: 'Sessão inválida', redirectToLogin: true });
        }

        req.user = sessionData.session;
        req.sessionToken = sessionToken;
        next();
    } catch (error) {
        console.error('❌ Erro ao verificar autenticação:', error.message);
        if (error.name === 'AbortError' || error.code === 'ECONNREFUSED') {
            console.log('⚠️ Portal offline - permitindo acesso');
            req.user = { offline: true };
            return next();
        }
        return res.status(500).json({ error: 'Erro ao verificar autenticação' });
    }
}

// Servir arquivos estáticos
const publicPath = path.join(__dirname, 'public');
if (!fs.existsSync(publicPath)) fs.mkdirSync(publicPath, { recursive: true });
app.use(express.static(publicPath, {
    index: 'index.html',
    setHeaders: (res, path) => {
        if (path.endsWith('.html')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
        else if (path.endsWith('.css')) res.setHeader('Content-Type', 'text/css; charset=utf-8');
        else if (path.endsWith('.js')) res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    }
}));

// Health check (sem autenticação)
app.get('/health', async (req, res) => {
    try {
        const { count, error } = await supabase
            .from('users')
            .select('*', { count: 'exact', head: true });
        res.json({
            status: error ? 'unhealthy' : 'healthy',
            database: error ? 'disconnected' : 'connected',
            timestamp: new Date().toISOString(),
            service: 'usuarios',
            usuarios: count || 0
        });
    } catch (error) {
        res.status(500).json({ status: 'unhealthy', error: error.message });
    }
});

// HEAD request para verificar conexão
app.head('/api/usuarios', (req, res) => res.status(200).end());

// Aplicar autenticação nas rotas da API
app.use('/api', verificarAutenticacao);

// ============================================
// ROTAS DA API - USUÁRIOS
// ============================================

// Listar usuários (com paginação e busca)
app.get('/api/usuarios', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = Math.min(parseInt(req.query.limit) || 50, 50);
        const search = req.query.search || null;

        const from = (page - 1) * limit;
        const to = from + limit - 1;

        let query = supabase
            .from('users')
            .select('id, username, name, sector, is_admin, is_active, authorized_ips', { count: 'exact' })
            .order('name', { ascending: true });

        if (search) {
            query = query.or(`name.ilike.%${search}%,username.ilike.%${search}%,sector.ilike.%${search}%`);
        }

        const { data, error, count } = await query.range(from, to);
        if (error) throw error;

        res.json({
            data: data || [],
            total: count || 0,
            page,
            limit,
            totalPages: Math.ceil((count || 0) / limit)
        });
    } catch (error) {
        console.error('❌ Erro em GET /usuarios:', error);
        res.status(500).json({ error: 'Erro ao buscar usuários', message: error.message });
    }
});

// Buscar usuário específico
app.get('/api/usuarios/:id', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('users')
            .select('id, username, name, sector, is_admin, is_active, authorized_ips')
            .eq('id', req.params.id)
            .single();

        if (error) return res.status(404).json({ error: 'Usuário não encontrado' });
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar usuário', message: error.message });
    }
});

// Criar novo usuário
app.post('/api/usuarios', async (req, res) => {
    try {
        const { username, password, name, sector, is_admin, is_active, authorized_ips } = req.body;

        if (!username || !password || !name) {
            return res.status(400).json({ error: 'Nome, usuário e senha são obrigatórios' });
        }

        // Verificar se username já existe
        const { data: existing } = await supabase
            .from('users')
            .select('id')
            .ilike('username', username.trim())
            .maybeSingle();
        if (existing) {
            return res.status(400).json({ error: 'Nome de usuário já existe' });
        }

        const userData = {
            username: username.trim().toLowerCase(),
            password: password, // Mantendo texto plano (igual ao Portal)
            name: name.trim().toUpperCase(),
            sector: sector || null,
            is_admin: is_admin || false,
            is_active: is_active !== undefined ? is_active : true,
            authorized_ips: authorized_ips || []
        };

        const { data, error } = await supabase
            .from('users')
            .insert([userData])
            .select('id, username, name, sector, is_admin, is_active, authorized_ips')
            .single();

        if (error) throw error;
        res.status(201).json(data);
    } catch (error) {
        console.error('❌ Erro em POST /usuarios:', error);
        res.status(500).json({ error: 'Erro ao criar usuário', message: error.message });
    }
});

// Atualizar usuário
app.put('/api/usuarios/:id', async (req, res) => {
    try {
        const { username, password, name, sector, is_admin, is_active, authorized_ips } = req.body;

        if (!username || !name) {
            return res.status(400).json({ error: 'Nome e usuário são obrigatórios' });
        }

        // Verificar se username já existe (exceto o próprio)
        const { data: existing } = await supabase
            .from('users')
            .select('id')
            .ilike('username', username.trim())
            .neq('id', req.params.id)
            .maybeSingle();
        if (existing) {
            return res.status(400).json({ error: 'Nome de usuário já existe' });
        }

        const updateData = {
            username: username.trim().toLowerCase(),
            name: name.trim().toUpperCase(),
            sector: sector || null,
            is_admin: is_admin || false,
            is_active: is_active !== undefined ? is_active : true,
            authorized_ips: authorized_ips || []
        };

        // Só atualiza senha se foi fornecida
        if (password && password.trim() !== '') {
            updateData.password = password;
        }

        const { data, error } = await supabase
            .from('users')
            .update(updateData)
            .eq('id', req.params.id)
            .select('id, username, name, sector, is_admin, is_active, authorized_ips')
            .single();

        if (error) return res.status(404).json({ error: 'Usuário não encontrado' });
        res.json(data);
    } catch (error) {
        console.error('❌ Erro em PUT /usuarios:', error);
        res.status(500).json({ error: 'Erro ao atualizar usuário', message: error.message });
    }
});

// Deletar usuário
app.delete('/api/usuarios/:id', async (req, res) => {
    try {
        const { error } = await supabase
            .from('users')
            .delete()
            .eq('id', req.params.id);

        if (error) throw error;
        res.status(204).end();
    } catch (error) {
        console.error('❌ Erro em DELETE /usuarios:', error);
        res.status(500).json({ error: 'Erro ao excluir usuário', message: error.message });
    }
});

// ============================================
// ROTAS PRINCIPAIS
// ============================================
app.get('/', (req, res) => res.sendFile(path.join(publicPath, 'index.html')));
app.get('/app', (req, res) => res.sendFile(path.join(publicPath, 'index.html')));

// 404
app.use((req, res) => {
    res.status(404).json({ error: '404 - Rota não encontrada', path: req.path });
});

// Tratamento de erros
app.use((error, req, res, next) => {
    console.error('❌ Erro interno:', error);
    res.status(500).json({ error: 'Erro interno do servidor', message: error.message });
});

// Iniciar servidor
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('\n🚀 ========================================');
    console.log('✅ Servidor Usuários ONLINE');
    console.log(`✅ Porta: ${PORT}`);
    console.log(`✅ Database: Conectado ao Supabase`);
    console.log(`✅ Autenticação: Ativa (Portal)`);
    console.log('🚀 ========================================\n');
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('⚠️ SIGTERM recebido, encerrando servidor...');
    server.close(() => process.exit(0));
});

// Teste de conexão inicial
(async () => {
    try {
        const { count, error } = await supabase
            .from('users')
            .select('*', { count: 'exact', head: true });
        if (error) console.error('❌ Erro ao conectar com Supabase:', error.message);
        else console.log(`✅ Conexão com Supabase verificada (${count || 0} usuários)`);
    } catch (error) {
        console.error('❌ Erro ao testar conexão:', error.message);
    }
})();
