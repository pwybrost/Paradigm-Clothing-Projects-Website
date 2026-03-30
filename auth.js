export function signup(username, email, phone, password) {
    // Check if the email is already registered
    if (localStorage.getItem(email)) return false; 
    
    // Save new user credentials to localStorage
    const userData = { username, email, phone, password };
    localStorage.setItem(email, JSON.stringify(userData));
    return true;
}

export function login(email, password) {
    // 1. Check if user exists
    const storedData = localStorage.getItem(email);
    if (!storedData) return { success: false, error: 'not_found' };
    
    // 2. Validate password
    const user = JSON.parse(storedData);
    if (user.password !== password) return { success: false, error: 'wrong_password' };
    
    // 3. Create active session (using the 'paradigm_session' key the Archive expects)
    const sessionData = { 
        username: user.username, 
        email: user.email, 
        phone: user.phone,
        loginTime: new Date().toISOString()
    };
    localStorage.setItem('paradigm_session', JSON.stringify(sessionData));
    
    return { success: true };
}

export function getCurrentUser() {
    // Retrieve the active session for the Archive page
    const userJson = localStorage.getItem('paradigm_session');
    if (!userJson) return null;
    return JSON.parse(userJson);
}

export function resetAccount(email) {
    // Delete user data from localStorage
    localStorage.removeItem(email);
}

export function logout() {
    // Wipe the active session and return to login
    localStorage.removeItem('paradigm_session');
    window.location.href = 'Login.html';
}
