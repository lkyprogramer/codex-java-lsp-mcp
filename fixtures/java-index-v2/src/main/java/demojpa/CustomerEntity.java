package demojpa;

import java.util.List;
import jakarta.persistence.Entity;
import jakarta.persistence.OneToMany;

@Entity
public class CustomerEntity {
  private Long id;

  @OneToMany
  private List<OrderEntity> orders;

  public Long getId() {
    return id;
  }

  public List<OrderEntity> getOrders() {
    return orders;
  }
}
