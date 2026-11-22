export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: { ink: '#0a0a0c', coal: '#17171b', ember: '#ff2d4f', rose: '#ff4fa3' },
      fontFamily: { sans: ['"Plus Jakarta Sans"', 'system-ui', 'sans-serif'], display: ['"Bebas Neue"', 'Impact', 'sans-serif'] },
      keyframes: {
        rise: { from: { opacity: 0, transform: 'translateY(10px)' }, to: { opacity: 1, transform: 'none' } },
        slide: { '0%': { transform: 'translateX(-100%)' }, '100%': { transform: 'translateX(300%)' } },
      },
      animation: { rise: 'rise .5s ease-out both', slide: 'slide 1.4s ease-in-out infinite' },
    },
  },
  plugins: [],
};
