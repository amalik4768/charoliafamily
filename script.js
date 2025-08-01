function createNode(person) {
  const node = document.createElement("div");
  node.className = "node";
  node.textContent = person.name;

  const container = document.createElement("div");
  container.appendChild(node);

  if (person.children && person.children.length > 0) {
    const connector = document.createElement("div");
    connector.className = "connector";
    container.appendChild(connector);

    const childrenContainer = document.createElement("div");
    childrenContainer.className = "children";

    person.children.forEach(child => {
      childrenContainer.appendChild(createNode(child));
    });

    container.appendChild(childrenContainer);
  }

  return container;
}

document.getElementById("tree").appendChild(createNode(familyTreeData));
