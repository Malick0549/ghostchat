/**
 * GHOSTCHAT LANDING PAGE
 * Theme management and animations
 */

document.addEventListener('DOMContentLoaded', () => {
    // Initialize theme
    initTheme();
    
    // Setup mobile menu
    setupMobileMenu();
    
    // Setup smooth scrolling
    setupSmoothScroll();
    
    // Setup animations
    setupScrollAnimations();
});

function initTheme() {
    // Load saved theme
    const savedTheme = localStorage.getItem('ghostchat_theme') || 'dark';
    applyTheme(savedTheme);
    
    // Setup theme toggle button
    const themeToggle = document.getElementById('themeToggleLanding');
    if (themeToggle) {
        themeToggle.addEventListener('click', () => {
            const themes = ['dark', 'light', 'neon'];
            const currentTheme = document.body.getAttribute('data-theme') || 'dark';
            const currentIndex = themes.indexOf(currentTheme);
            const nextTheme = themes[(currentIndex + 1) % themes.length];
            applyTheme(nextTheme);
        });
    }
}

function applyTheme(themeName) {
    // Remove existing theme link
    const existingLink = document.getElementById('theme-stylesheet');
    if (existingLink) {
        existingLink.remove();
    }
    
    // Add new theme stylesheet
    const link = document.createElement('link');
    link.id = 'theme-stylesheet';
    link.rel = 'stylesheet';
    link.href = `themes/${themeName}.theme.css`;
    document.head.appendChild(link);
    
    // Set data attribute
    document.body.setAttribute('data-theme', themeName);
    
    // Update toggle icon
    const themeToggle = document.getElementById('themeToggleLanding');
    if (themeToggle) {
        const icon = themeToggle.querySelector('i');
        if (icon) {
            if (themeName === 'dark') icon.className = 'fas fa-moon';
            else if (themeName === 'light') icon.className = 'fas fa-sun';
            else if (themeName === 'neon') icon.className = 'fas fa-bolt';
        }
    }
    
    // Save preference
    localStorage.setItem('ghostchat_theme', themeName);
    
    // Update meta theme color
    let metaTheme = document.querySelector('meta[name="theme-color"]');
    if (!metaTheme) {
        metaTheme = document.createElement('meta');
        metaTheme.name = 'theme-color';
        document.head.appendChild(metaTheme);
    }
    
    const colors = {
        dark: '#0a0a0f',
        light: '#f5f5f7',
        neon: '#050508'
    };
    metaTheme.content = colors[themeName];
}

function setupMobileMenu() {
    const mobileMenuBtn = document.querySelector('.mobile-menu');
    const navLinks = document.querySelector('.nav-links');
    
    if (mobileMenuBtn && navLinks) {
        mobileMenuBtn.addEventListener('click', () => {
            navLinks.classList.toggle('show');
            mobileMenuBtn.querySelector('i').classList.toggle('fa-bars');
            mobileMenuBtn.querySelector('i').classList.toggle('fa-times');
        });
    }
}

function setupSmoothScroll() {
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function(e) {
            e.preventDefault();
            const target = document.querySelector(this.getAttribute('href'));
            if (target) {
                target.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                });
            }
        });
    });
}

function setupScrollAnimations() {
    const observerOptions = {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    };
    
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('fade-in');
                observer.unobserve(entry.target);
            }
        });
    }, observerOptions);
    
    document.querySelectorAll('.feature-card, .layer, .security-stats .stat').forEach(el => {
        el.style.opacity = '0';
        observer.observe(el);
    });
}

// Add loading animation for page transition
window.addEventListener('load', () => {
    document.body.classList.add('loaded');
});
// Mobile menu toggle
const mobileMenuBtn = document.querySelector('.mobile-menu');
const navLinks = document.querySelector('.nav-links');

if (mobileMenuBtn && navLinks) {
    mobileMenuBtn.addEventListener('click', function() {
        navLinks.classList.toggle('show');
        const icon = this.querySelector('i');
        if (icon) {
            icon.classList.toggle('fa-bars');
            icon.classList.toggle('fa-times');
        }
    });
}
