// The new tab page has no bridge to the app. Its box hands typing to the address bar by asking
// for open-eyes://focus-address, which the app allows from this page only.
const hour = new Date().getHours();
document.getElementById("greeting").textContent = hour < 5 ? "Good night" : hour < 12 ? "Good morning" : hour < 19 ? "Good afternoon" : "Good evening";

const box = document.getElementById("box");
const focusAddress = (text = "") => (location.href = `open-eyes://focus-address?text=${encodeURIComponent(text)}`);
box.addEventListener("click", () => focusAddress());
box.addEventListener("keydown", (event) => {
  if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    focusAddress(event.key);
  } else if (event.key === "Enter") focusAddress();
});
box.focus();
lucide.createIcons();
